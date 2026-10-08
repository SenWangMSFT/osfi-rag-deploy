"""Ask a question end to end and print the gated answer with its citations.

The question is asked as you: your az login identity's Azure AI Search token goes with it, as the web server sends a
signed-in user's, so the answer only draws on the institutions your groups can see.

    python scripts/ask.py "What was RBC's CET1 ratio at the end of fiscal 2025?"   # deployed API, Direct retrieval
    python scripts/ask.py --mode agent "..."   # deployed API, Foundry Agent
    python scripts/ask.py --local "..."        # the API code in your working tree, run on this machine as you
    python scripts/ask.py --local --raw "..."  # also print the full API response
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess

import requests

from _common import SEARCH_SCOPE, AzureClient, load_env

USER_TOKEN_HEADER = "x-search-user-token"


def via_function(env: dict[str, str], question: str, mode: str, token: str) -> dict:
    az = shutil.which("az") or "az"
    key = subprocess.run(
        [az, "functionapp", "keys", "list", "-g", env["AZURE_RESOURCE_GROUP"], "-n", env["FUNCTION_APP_NAME"],
         "--query", "functionKeys.default", "-o", "tsv"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    response = requests.post(
        f"{env['FUNCTION_APP_URL']}/api/ask",
        json={"question": question, "mode": mode},
        headers={"x-functions-key": key, USER_TOKEN_HEADER: token},
        timeout=180,
    )
    if response.status_code != 200:
        raise SystemExit(f"/api/ask returned {response.status_code}: {response.text[:2000]}")
    return response.json()


def local(env: dict[str, str], question: str, mode: str, token: str) -> dict:
    """Runs the /api/ask handler in-process, so gate and agent-parsing changes can be tried without deploying."""
    os.environ.update(env)
    import azure.functions as func

    import function_app

    request = func.HttpRequest(
        method="POST",
        url="http://localhost/api/ask",
        headers={"Content-Type": "application/json", USER_TOKEN_HEADER: token},
        body=json.dumps({"question": question, "mode": mode}).encode("utf-8"),
    )
    response = function_app.ask.build().get_user_function()(request)
    if response.status_code != 200:
        raise SystemExit(f"/api/ask returned {response.status_code}: {response.get_body().decode()[:2000]}")
    return json.loads(response.get_body())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("question")
    parser.add_argument("--mode", choices=("direct", "agent"), default="direct", help="answer mode (default direct)")
    parser.add_argument("--local", action="store_true", help="run the API code from this checkout instead of Azure")
    parser.add_argument("--raw", action="store_true", help="also print the full API response")
    args = parser.parse_args()

    env = load_env()
    token = AzureClient().token(SEARCH_SCOPE)
    data = local(env, args.question, args.mode, token) if args.local else via_function(env, args.question, args.mode, token)
    if args.raw:
        print(json.dumps(data, indent=2, ensure_ascii=False)[:40000])

    print(f"\nQ: {args.question}\n\nA ({data.get('mode', 'direct')}): {data['answer']}\n")
    for citation in data["citations"]:
        print(f"  [{citation['n']}] {citation['label']}   ({citation['source_file']}#page={citation['page_from']})")
    for warning in data["warnings"]:
        print(f"  ! {warning}")
    d = data["diagnostics"]
    for stage in d.get("activity") or []:
        if stage.get("query"):
            print(f"  search: {stage['query']}  ({stage.get('count')} results)")
    agent = d.get("agent")
    if agent:
        print(f"  agent: {agent.get('name')} v{agent.get('version')}, {agent.get('tool_calls')} tool calls, {agent.get('response_id')}")
    print(
        f"\ngate {'passed' if d.get('gate_passed') else 'FAILED'} | grounded sentences {d.get('grounded_sentence_ratio')} "
        f"({d.get('sentences_grounded')}/{d.get('sentences_total')}) | {d.get('reference_count')} references | "
        f"{d.get('elapsed_ms')} ms | HTTP {d.get('retrieve_status')} | tokens in {d.get('input_tokens')} out {d.get('output_tokens')}"
    )


if __name__ == "__main__":
    main()
