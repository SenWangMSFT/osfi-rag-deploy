"""Creates the Azure AI Search pipeline from search/*.json (placeholders filled from .env).

Order: Content Understanding defaults -> data source (the SharePoint sync's staging container) -> chunk index ->
staging index -> skillset -> knowledge source -> knowledge bases (answer synthesis, then the Foundry agent's
extractive one) -> indexer. The indexer writes to the staging index, and the SharePoint sync copies each document's
chunks into the chunk index with permissions. The indexer goes last because creating it starts a run; the sync starts
every later run.

    python scripts/setup_search.py                  # create or update everything
    python scripts/setup_search.py --recreate-index # drop and rebuild after changing index fields
    python scripts/setup_search.py --skip-indexer   # everything except the indexer
"""

from __future__ import annotations

import argparse

from _common import COGNITIVE_SCOPE, ROOT, SEARCH_SCOPE, AzureClient, load_env, render, search_url

# (template, REST collection, .env key with the object name)
OBJECTS = [
    ("datasource.json", "datasources", "SEARCH_DATASOURCE"),
    ("index.json", "indexes", "SEARCH_INDEX"),
    ("staging-index.json", "indexes", "SEARCH_STAGING_INDEX"),
    ("skillset.json", "skillsets", "SEARCH_SKILLSET"),
    ("knowledge-source.json", "knowledgesources", "KNOWLEDGE_SOURCE"),
    ("knowledge-base.json", "knowledgebases", "KNOWLEDGE_BASE"),
    ("knowledge-base-agent.json", "knowledgebases", "AGENT_KNOWLEDGE_BASE"),
    ("indexer.json", "indexers", "SEARCH_INDEXER"),
]


def set_content_understanding_defaults(client: AzureClient, env: dict[str, str]) -> None:
    """Maps CU's model names/aliases to our deployments. The skill also names its deployment explicitly."""
    url = f"{env['FOUNDRY_ENDPOINT']}/contentunderstanding/defaults?api-version=2025-11-01"
    completion, embedding = env["EXTRACTION_DEPLOYMENT"], env["EMBEDDING_DEPLOYMENT"]
    body = {
        "modelDeployments": {
            env["EXTRACTION_MODEL"]: completion,
            env["EMBEDDING_MODEL"]: embedding,
            "prebuilt-analyzer-completion": completion,
            "prebuilt-analyzer-completion-mini": completion,
            "prebuilt-analyzer-embedding": embedding,
        }
    }
    last_error: Exception | None = None
    for content_type in ("application/merge-patch+json", "application/json"):
        try:
            client.request("PATCH", url, COGNITIVE_SCOPE, body=body, headers={"Content-Type": content_type})
            print("  Content Understanding defaults set")
            return
        except RuntimeError as exc:
            last_error = exc
            if " 415:" not in str(exc):
                break
    print(f"  warning: could not set Content Understanding defaults: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--recreate-index", action="store_true", help="delete KBs, KS, indexer and index first")
    parser.add_argument("--skip-indexer", action="store_true", help="don't create (and therefore run) the indexer")
    args = parser.parse_args()

    env = load_env()
    client = AzureClient()
    # Get both tokens first. In a CI/CD pipeline the az login assertion is only valid for a few minutes, and waiting
    # for new role assignments to apply can take longer than that.
    client.token(COGNITIVE_SCOPE)
    client.token(SEARCH_SCOPE)

    print("Content Understanding model defaults")
    set_content_understanding_defaults(client, env)

    if args.recreate_index:
        for collection, key in (
            ("knowledgebases", "AGENT_KNOWLEDGE_BASE"),
            ("knowledgebases", "KNOWLEDGE_BASE"),
            ("knowledgesources", "KNOWLEDGE_SOURCE"),
            ("indexers", "SEARCH_INDEXER"),
            ("indexes", "SEARCH_STAGING_INDEX"),
            ("indexes", "SEARCH_INDEX"),
        ):
            print(f"DELETE {collection}/{env[key]}")
            client.request("DELETE", search_url(env, f"{collection}/{env[key]}"), ok=(200, 204, 404))

    for template, collection, key in OBJECTS:
        if args.skip_indexer and collection == "indexers":
            continue
        print(f"PUT {collection}/{env[key]}")
        client.request(
            "PUT",
            search_url(env, f"{collection}/{env[key]}"),
            body=render(ROOT / "search" / template, env),
            headers={"Prefer": "return=minimal"},
            ok=(200, 201, 204),
        )

    print("\nDone. The SharePoint sync stages files and starts the indexer; check progress with: python scripts/sync.py")


if __name__ == "__main__":
    main()
