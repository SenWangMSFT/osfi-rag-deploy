"""Smoke test for the deployed Function App endpoints and the web app in front of them.

The API needs a signed-in user's Azure AI Search token on every call; this test uses your az login identity's, so the
answer and citation checks run when your groups can see at least one indexed document. A pipeline's identity isn't
a user, so in a CI/CD pipeline those checks are skipped rather than failed.

    python scripts/smoke_test.py
"""

from __future__ import annotations

import shutil
import subprocess
import time
from collections.abc import Callable
from urllib.parse import quote

import requests

from _common import SEARCH_SCOPE, AzureClient, load_env

USER_TOKEN_HEADER = "x-search-user-token"


def main() -> None:
    env = load_env()
    az = shutil.which("az") or "az"
    key = subprocess.run(
        [az, "functionapp", "keys", "list", "-g", env["AZURE_RESOURCE_GROUP"], "-n", env["FUNCTION_APP_NAME"],
         "--query", "functionKeys.default", "-o", "tsv"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    base = env["FUNCTION_APP_URL"]
    keyed = {"x-functions-key": key}
    auth = {**keyed, USER_TOKEN_HEADER: AzureClient().token(SEARCH_SCOPE)}
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str) -> None:
        results.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")

    def skip(name: str, detail: str) -> None:
        print(f"SKIP  {name}: {detail}")

    # Right after a deployment the host can still be restarting.
    for _ in range(12):
        listing = requests.get(f"{base}/api/documents", headers=auth, timeout=60)
        if listing.status_code in (200, 401):
            break
        time.sleep(15)
    as_user = listing.status_code == 200
    documents = listing.json().get("documents", []) if as_user else []
    if as_user:
        check("documents list as you", True, f"HTTP 200, {len(documents)} documents your groups can see")
    else:
        skip("checks as a signed-in user", f"HTTP {listing.status_code}: this identity isn't a user Search accepts")

    anonymous = requests.post(f"{base}/api/ask", json={"question": "x"}, timeout=60)
    check("ask requires the function key", anonymous.status_code == 401, f"HTTP {anonymous.status_code}")

    no_user = requests.post(f"{base}/api/ask", json={"question": "x"}, headers=keyed, timeout=60)
    check(
        "ask requires a user token",
        no_user.status_code == 401 and no_user.json().get("code") == "sign_in_required",
        f"HTTP {no_user.status_code}",
    )
    for path in ("/api/documents", "/api/docs/does-not-exist", "/api/citation?url=x"):
        refused = requests.get(f"{base}{path}", headers=keyed, timeout=60)
        check(f"{path.split('?')[0]} requires a user token", refused.status_code == 401, f"HTTP {refused.status_code}")

    if as_user:
        invalid = requests.post(f"{base}/api/ask", json={}, headers=auth, timeout=60)
        check("ask validates input", invalid.status_code == 400, f"HTTP {invalid.status_code}")
        ask_as_user(base, auth, bool(documents), check, skip)

        foreign = requests.get(
            f"{base}/api/citation", params={"url": "https://example.com/indexes/x/docs/y"}, headers=auth, timeout=60
        )
        check("citation preview refuses foreign URLs", foreign.status_code == 400, f"HTTP {foreign.status_code}")
        missing = requests.get(f"{base}/api/docs/does-not-exist", headers=auth, timeout=60)
        check("unknown document is 404", missing.status_code == 404, f"HTTP {missing.status_code}")

    web = env.get("WEB_APP_URL")
    if web:
        page = requests.get(web, timeout=120, allow_redirects=False)
        if env.get("WEB_AUTH_CLIENT_ID"):
            check(
                "web app sends visitors to sign in",
                page.status_code in (302, 401) and "login" in page.headers.get("Location", "login"),
                f"HTTP {page.status_code}",
            )
        else:
            check(
                "web app serves the UI with a CSP",
                page.status_code == 200 and "Content-Security-Policy" in page.headers,
                f"HTTP {page.status_code}",
            )
            proxied = requests.get(f"{web}/api/documents", timeout=60)
            check("web app's API refuses callers who haven't signed in", proxied.status_code == 401, f"HTTP {proxied.status_code}")
            escaped = requests.get(f"{web}/api/%2e%2e/admin/host/status", timeout=60)
            check(
                "web app keeps proxied paths under /api",
                "text/html" in escaped.headers.get("Content-Type", ""),
                f"HTTP {escaped.status_code}",
            )
        health = requests.get(f"{web}/healthz", timeout=60)
        check("web app health endpoint", health.status_code == 200, f"HTTP {health.status_code}")

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        raise SystemExit(1)


def ask_as_user(
    base: str,
    auth: dict[str, str],
    has_documents: bool,
    check: Callable[[str, bool, str], None],
    skip: Callable[[str, str], None],
) -> None:
    for mode, question in (
        ("direct", "What was the CET1 ratio at October 31, 2025?"),
        ("agent", "What was RBC's CET1 ratio at the end of fiscal 2025?"),
    ):
        response = requests.post(f"{base}/api/ask", json={"question": question, "mode": mode}, headers=auth, timeout=180)
        body = response.json() if response.status_code == 200 else {}
        citations = body.get("citations") or []
        gate = (body.get("diagnostics") or {}).get("gate_passed")
        check(
            f"ask ({mode}) returns a gated answer",
            response.status_code == 200 and body.get("mode") == mode and gate is True,
            f"HTTP {response.status_code}, {len(citations)} citations, {body.get('diagnostics', {}).get('elapsed_ms')} ms",
        )
        if not has_documents:
            skip(f"ask ({mode}) citations", "your groups can't see any indexed document yet")
        elif mode == "direct":
            check("ask (direct) cites a page", bool(citations), f"{len(citations)} citations")
            if citations:
                check_citation_links(base, auth, citations[0], check)


def check_citation_links(base: str, auth: dict[str, str], first: dict, check: Callable[[str, bool, str], None]) -> None:
    document = quote(first.get("document_id") or "", safe="")
    check("citation names its SharePoint document", bool(document), f"document_id {first.get('document_id')}")
    pdf = requests.get(f"{base}/api/docs/{document}", headers={**auth, "Range": "bytes=0-1023"}, timeout=120)
    check(
        "cited PDF streams from SharePoint",
        pdf.status_code == 200 and pdf.content.startswith(b"%PDF") and "pdf" in pdf.headers.get("Content-Type", ""),
        f"HTTP {pdf.status_code}, {len(pdf.content)} bytes",
    )
    as_json = requests.get(f"{base}/api/docs/{document}", params={"format": "json"}, headers=auth, timeout=60)
    check(
        "pdf link as JSON",
        as_json.status_code == 200 and as_json.json().get("url") == f"/api/docs/{document}",
        f"HTTP {as_json.status_code}",
    )
    if first.get("citation_url"):
        preview = requests.get(f"{base}/api/citation", params={"url": first["citation_url"]}, headers=auth, timeout=60)
        data = preview.json() if preview.status_code == 200 else {}
        check(
            "citationUrl preview resolves to the cited page",
            data.get("page_number_from") == first["page_from"],
            f"HTTP {preview.status_code}, page {data.get('page_number_from')}",
        )


if __name__ == "__main__":
    main()
