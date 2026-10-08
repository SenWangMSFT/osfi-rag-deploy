"""Shared helpers for the setup and smoke-test scripts (auth = your az login)."""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import requests
from azure.identity import AzureCliCredential

ROOT = Path(__file__).resolve().parents[1]
SEARCH_SCOPE = "https://search.azure.com/.default"
COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default"
FOUNDRY_SCOPE = "https://ai.azure.com/.default"
GRAPH_SCOPE = "https://graph.microsoft.com/.default"
# The index filters every query by the caller's groups; operator scripts read all chunks instead (needs Search Index
# Data Contributor).
ELEVATED_READ = {"x-ms-enable-elevated-read": "true"}
_PLACEHOLDER = re.compile(r"\$\{([A-Z0-9_]+)\}")

sys.path.insert(0, str(ROOT / "src" / "function_app"))


def load_env() -> dict[str, str]:
    env_file = ROOT / ".env"
    if not env_file.exists():
        sys.exit("Missing .env - run scripts/deploy.ps1 first.")
    values: dict[str, str] = {}
    for line in env_file.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


class AzureClient:
    """Tiny REST client that retries while freshly created role assignments propagate."""

    def __init__(self) -> None:
        self.credential = AzureCliCredential(process_timeout=60)
        self._tokens: dict[str, tuple[str, float]] = {}
        self.session = requests.Session()

    def token(self, scope: str) -> str:
        cached = self._tokens.get(scope)
        if cached is None or cached[1] - time.time() < 300:
            access = self.credential.get_token(scope)
            cached = self._tokens[scope] = (access.token, access.expires_on)
        return cached[0]

    def request(
        self,
        method: str,
        url: str,
        scope: str = SEARCH_SCOPE,
        *,
        body: Any = None,
        headers: dict[str, str] | None = None,
        ok: tuple[int, ...] = (200, 201, 202, 204),
        wait_for_rbac: bool = True,
    ) -> requests.Response:
        deadline = time.time() + (600 if wait_for_rbac else 120)
        attempt = 0
        while True:
            attempt += 1
            request_headers = {"Authorization": f"Bearer {self.token(scope)}", "Content-Type": "application/json"}
            request_headers.update(headers or {})
            response = self.session.request(method, url, json=body, headers=request_headers, timeout=180)
            if response.status_code in ok:
                return response
            retryable = (
                response.status_code in (429, 502, 503)
                or (response.status_code == 403 and wait_for_rbac)
                # Azure AI Search serializes updates to an object and rejects an overlapping one without changing it.
                or (response.status_code == 409 and "conflicting update" in response.text)
            )
            if retryable and time.time() < deadline:
                delay = min(30, 5 * attempt)
                print(f"  {method} {url.split('?')[0]} -> {response.status_code}; retrying in {delay}s", flush=True)
                time.sleep(delay)
                continue
            raise RuntimeError(f"{method} {url} failed with {response.status_code}: {response.text[:3000]}")


def search_url(env: dict[str, str], path: str) -> str:
    return f"{env['SEARCH_ENDPOINT'].rstrip('/')}/{path}?api-version={env['SEARCH_API_VERSION']}"


def render(template: Path, env: dict[str, str]) -> dict:
    """Loads a JSON template, filling ${VAR} placeholders from env (values are inserted as JSON string content)."""

    def fill(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in env:
            raise KeyError(f"{template.name}: ${{{key}}} is not in .env")
        return json.dumps(env[key])[1:-1]

    return json.loads(_PLACEHOLDER.sub(fill, template.read_text(encoding="utf-8")))
