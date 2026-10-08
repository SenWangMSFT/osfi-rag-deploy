"""Indexer status and runs, plus spot checks for page provenance (plan Phase 1 gate).

    python scripts/indexer.py                 # status, errors, chunks per document
    python scripts/indexer.py --watch         # poll until the current run finishes
    python scripts/indexer.py --run           # start a run (only new/changed PDFs are processed)
    python scripts/indexer.py --reset         # forget change tracking and re-process everything (re-bills CU)
    python scripts/indexer.py --sample 10     # random chunks with doc + page, to check against the PDFs
    python scripts/indexer.py --search "CET1 ratio"   # hybrid + semantic query straight against the index
"""

from __future__ import annotations

import argparse
import random
import textwrap
import time

from _common import ELEVATED_READ, AzureClient, load_env, search_url

PREVIEW_FIELDS = "doc_title,source_file,page_number_from,page_number_to,chunk_text"


def show_status(client: AzureClient, env: dict[str, str]) -> str:
    status = client.request("GET", search_url(env, f"indexers/{env['SEARCH_INDEXER']}/status")).json()
    last = status.get("lastResult") or {}
    print(
        f"indexer {status.get('status')} | last run {last.get('status')} | processed {last.get('itemsProcessed')} "
        f"failed {last.get('itemsFailed')} | {last.get('startTime')} -> {last.get('endTime')}"
    )
    if last.get("errorMessage"):
        print(f"  run error: {last['errorMessage']}")
    for error in (last.get("errors") or [])[:10]:
        print(f"  ERROR {error.get('name') or error.get('key')}: {error.get('errorMessage')} {error.get('details') or ''}")
    for warning in (last.get("warnings") or [])[:10]:
        print(f"  warning {warning.get('name') or warning.get('key')}: {warning.get('message')}")

    stats = client.request("GET", search_url(env, f"indexes/{env['SEARCH_INDEX']}/stats")).json()
    print(f"index: {stats.get('documentCount')} chunks | vector index {int(stats.get('vectorIndexSize') or 0) // 1_048_576} MB")
    facets = client.request(
        "POST",
        search_url(env, f"indexes/{env['SEARCH_INDEX']}/docs/search"),
        body={"search": "*", "top": 0, "facets": ["doc_title,count:100"]},
        headers=ELEVATED_READ,
    ).json()
    for facet in facets.get("@search.facets", {}).get("doc_title", []):
        print(f"  {facet['count']:>6} chunks  {facet['value']}")
    pending = client.request(
        "POST",
        search_url(env, f"indexes/{env['SEARCH_STAGING_INDEX']}/docs/search"),
        body={"search": "*", "top": 0, "count": True},
    ).json().get("@odata.count")
    if pending:
        print(f"  {pending:>6} chunks in the staging index, waiting for the sync to publish them")
    return last.get("status") or ""


def print_chunk(doc: dict) -> None:
    pages = doc.get("page_number_from")
    if doc.get("page_number_to") not in (None, pages):
        pages = f"{pages}-{doc['page_number_to']}"
    print(f"\n# {doc.get('doc_title')} | PDF page {pages} | {doc.get('source_file')}")
    print(textwrap.indent(textwrap.shorten(doc.get("chunk_text") or "", 600, placeholder=" ..."), "  "))


def sample(client: AzureClient, env: dict[str, str], count: int) -> None:
    url = search_url(env, f"indexes/{env['SEARCH_INDEX']}/docs/search")
    total = client.request("POST", url, body={"search": "*", "top": 0, "count": True}, headers=ELEVATED_READ).json()["@odata.count"]
    for skip in random.sample(range(total), min(count, total)):
        body = {"search": "*", "top": 1, "skip": skip, "orderby": "chunk_id", "select": PREVIEW_FIELDS}
        for doc in client.request("POST", url, body=body, headers=ELEVATED_READ).json().get("value", []):
            print_chunk(doc)


def search(client: AzureClient, env: dict[str, str], text: str) -> None:
    body = {
        "search": text,
        "queryType": "semantic",
        "semanticConfiguration": "annual-reports-semantic",
        "vectorQueries": [{"kind": "text", "text": text, "fields": "chunk_vector", "k": 20}],
        "top": 5,
        "select": PREVIEW_FIELDS,
    }
    for doc in client.request(
        "POST", search_url(env, f"indexes/{env['SEARCH_INDEX']}/docs/search"), body=body, headers=ELEVATED_READ
    ).json()["value"]:
        print(f"\nreranker {doc.get('@search.rerankerScore')}", end="")
        print_chunk(doc)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--sample", type=int, metavar="N")
    parser.add_argument("--search", metavar="TEXT")
    args = parser.parse_args()

    env = load_env()
    client = AzureClient()
    indexer = env["SEARCH_INDEXER"]

    if args.reset:
        client.request("POST", search_url(env, f"indexers/{indexer}/reset"), ok=(204,))
        print("Indexer reset; every PDF will be re-processed.")
    if args.reset or args.run:
        response = client.request("POST", search_url(env, f"indexers/{indexer}/run"), ok=(202, 409))
        print("Run started." if response.status_code == 202 else "A run is already in progress.")
        time.sleep(5)

    last_status = show_status(client, env)
    while args.watch and last_status in ("inProgress", ""):
        time.sleep(30)
        print()
        last_status = show_status(client, env)

    if args.sample:
        sample(client, env, args.sample)
    if args.search:
        search(client, env, args.search)


if __name__ == "__main__":
    main()
