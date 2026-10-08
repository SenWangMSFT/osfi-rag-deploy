"""Creates or updates the Foundry prompt agent from agent/agent.json and agent/instructions.md.

The agent calls the Foundry IQ knowledge base AGENT_KNOWLEDGE_BASE through its MCP endpoint, authenticating through
the project connection AGENT_CONNECTION (both deployed by infra/ and written to .env). A new agent version is created
only when the definition changes, so re-running is safe.

    python scripts/setup_agent.py          # create or update
    python scripts/setup_agent.py --show   # print the latest version
"""

from __future__ import annotations

import argparse
import base64
import json
import uuid
from typing import Any
from urllib.parse import quote

from _common import FOUNDRY_SCOPE, ROOT, AzureClient, load_env, render

API_VERSION = "v1"


def desired_version(env: dict[str, str]) -> dict[str, Any]:
    instructions = (ROOT / "agent" / "instructions.md").read_text(encoding="utf-8").strip()
    return render(ROOT / "agent" / "agent.json", {**env, "AGENT_INSTRUCTIONS": instructions})


def contains(actual: Any, expected: Any) -> bool:
    """True when every value in expected appears unchanged in actual; the service fills in defaults we don't set."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(contains(actual.get(key), value) for key, value in expected.items())
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(contains(item, want) for item, want in zip(actual, expected))
        )
    return actual == expected


def playground_url(env: dict[str, str], name: str, version: str) -> str:
    subscription = base64.urlsafe_b64encode(uuid.UUID(env["AZURE_SUBSCRIPTION_ID"]).bytes).rstrip(b"=").decode()
    return (
        f"https://ai.azure.com/nextgen/r/{subscription},{env['AZURE_RESOURCE_GROUP']},,{env['FOUNDRY_NAME']},"
        f"{env['FOUNDRY_PROJECT_NAME']}/build/agents/{name}/build?version={version}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--show", action="store_true", help="print the latest version and exit")
    args = parser.parse_args()

    env = load_env()
    client = AzureClient()
    name = env["AGENT_NAME"]
    agent_url = f"{env['FOUNDRY_PROJECT_ENDPOINT'].rstrip('/')}/agents/{quote(name, safe='')}"

    existing = client.request("GET", f"{agent_url}?api-version={API_VERSION}", FOUNDRY_SCOPE, ok=(200, 404))
    latest = (existing.json().get("versions") or {}).get("latest") if existing.status_code == 200 else None
    if args.show:
        print(json.dumps(latest, indent=2) if latest else f"Agent {name} doesn't exist yet.")
        return

    desired = desired_version(env)
    previous = latest["version"] if latest else None
    if latest and contains(latest, desired):
        print(f"Agent {name} is up to date (version {previous})")
    else:
        # MCP header values aren't returned on read, so the comparison above can't match them. Posting an
        # identical definition is harmless: the service returns the existing version instead of a new one.
        latest = client.request(
            "POST", f"{agent_url}/versions?api-version={API_VERSION}", FOUNDRY_SCOPE, body=desired
        ).json()
        if latest["version"] == previous:
            print(f"Agent {name} is up to date (version {previous})")
        else:
            print(f"Agent {name}: created version {latest['version']}")
    print(f"Playground: {playground_url(env, name, latest['version'])}")


if __name__ == "__main__":
    main()
