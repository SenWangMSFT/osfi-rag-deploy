"""SharePoint sync status, and a way to start the sync now instead of waiting for its 5-minute timer.

    python scripts/sync.py                 # sites, libraries, per-file status, staged files and chunks
    python scripts/sync.py --run           # start the sync in the deployed Function App, then show the status
    python scripts/sync.py --watch         # show the status every minute until nothing is waiting
    python scripts/sync.py --reset-state   # forget what's synced, so the next run re-indexes every file

--reset-state keeps the site registry. Use it after recreating the chunk index (setup_search.py --recreate-index) or
changing the skillset: staged files are deleted once published, so an indexer reset alone re-processes nothing. It
re-downloads every file and re-bills Content Understanding. Run it just after a sync run, not during one.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import time
from collections import Counter

import requests
from azure.core.exceptions import ResourceNotFoundError
from azure.identity import AzureCliCredential
from azure.storage.blob import BlobServiceClient

from _common import ELEVATED_READ, AzureClient, load_env, search_url


def run_now(env: dict[str, str]) -> None:
    """Invokes the timer function through the Functions admin API, which needs the master key, then waits until that
    run has saved the sites' state, so the status shown next includes the libraries it listed and the files it staged.
    """
    state = BlobServiceClient(env["STAGING_BLOB_ENDPOINT"], credential=AzureCliCredential()).get_container_client(
        env["SYNC_STATE_CONTAINER"]
    )
    if not read_json(state, "registry.json", {"sites": []})["sites"]:
        raise SystemExit("No sites registered yet: python scripts/onboard_sites.py")
    before = last_modified(state, "sites.json")
    az = shutil.which("az") or "az"
    key = subprocess.run(
        [az, "functionapp", "keys", "list", "-g", env["AZURE_RESOURCE_GROUP"], "-n", env["FUNCTION_APP_NAME"],
         "--query", "masterKey", "-o", "tsv"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    response = requests.post(
        f"{env['FUNCTION_APP_URL']}/admin/functions/sharepoint_sync",
        json={"input": ""},
        headers={"x-functions-key": key},
        timeout=60,
    )
    if response.status_code != 202:
        raise SystemExit(f"Starting the sync failed: HTTP {response.status_code} {response.text[:500]}")
    print("Sync started in the Function App. Its summary goes to Application Insights (traces: sharepoint_sync).")
    # The admin API returns at once; the run saves sites.json after listing every library and staging new files.
    print("Waiting for it to list the libraries and stage new files...", flush=True)
    deadline = time.time() + 600
    while last_modified(state, "sites.json") == before:
        if time.time() > deadline:
            print("It hasn't saved its state within 10 minutes; showing the last saved status.")
            break
        time.sleep(10)
    print()


def last_modified(container, name: str):
    try:
        return container.get_blob_client(name).get_blob_properties().last_modified
    except ResourceNotFoundError:
        return None


def read_json(container, name: str, default=None):
    try:
        return json.loads(container.download_blob(name).readall())
    except ResourceNotFoundError:
        return default


def reset_state(env: dict[str, str]) -> None:
    service = BlobServiceClient(env["STAGING_BLOB_ENDPOINT"], credential=AzureCliCredential())
    state = service.get_container_client(env["SYNC_STATE_CONTAINER"])
    names = [blob.name for blob in state.list_blobs() if blob.name != "registry.json"]
    for name in names:
        state.delete_blob(name)
    print(f"Deleted {len(names)} state file(s); the registry stays. The next sync run re-lists every library.\n")


def show(env: dict[str, str], client: AzureClient) -> int:
    """Prints the status and returns how many files are waiting for the indexer."""
    service = BlobServiceClient(env["STAGING_BLOB_ENDPOINT"], credential=AzureCliCredential())
    state = service.get_container_client(env["SYNC_STATE_CONTAINER"])
    registry = read_json(state, "registry.json", {"sites": []})
    sites_state = read_json(state, "sites.json", {})
    waiting = 0
    if not registry["sites"]:
        print("No sites registered yet: python scripts/onboard_sites.py")
    for site in registry["sites"]:
        key = site["institution_key"]
        drives = (sites_state.get(key) or {}).get("drives", [])
        print(f"{key} ({site['institution_name']}): {len(drives)} libraries  {site.get('site_url') or site.get('site_id')}")
        for drive_id in drives:
            drive = read_json(state, f"drives/{drive_id}.json", {"items": {}})
            items = drive.get("items", {})
            counts = Counter(item.get("status") for item in items.values())
            waiting += counts.get("staged", 0)
            position = "listing in progress" if drive.get("cursor") else ("up to date" if drive.get("delta_link") else "not listed yet")
            print(f"  library {drive_id[:12]}... {position}: " + (", ".join(f"{n} {s}" for s, n in sorted(counts.items())) or "no PDFs"))
            for item in sorted(items.values(), key=lambda i: i.get("name", "")):
                detail = f"{item.get('chunks')} chunks" if item.get("status") == "indexed" else (item.get("error") or "")
                print(f"    {item.get('status', '?'):<8} {item.get('name')}  {detail}".rstrip())

    staged = [blob.name for blob in service.get_container_client(env["STAGING_CONTAINER"]).list_blobs()]
    print(f"\nstaging container: {len(staged)} file(s)")
    pending = client.request(
        "POST",
        search_url(env, f"indexes/{env['SEARCH_STAGING_INDEX']}/docs/search"),
        body={"search": "*", "top": 0, "count": True},
    ).json()["@odata.count"]
    # Your az login token is a user token, so an elevated read shows every chunk regardless of permissions.
    facets = client.request(
        "POST",
        search_url(env, f"indexes/{env['SEARCH_INDEX']}/docs/search"),
        body={"search": "*", "top": 0, "facets": ["institution_key,count:1000"]},
        headers=ELEVATED_READ,
    ).json()["@search.facets"]["institution_key"]
    print(f"staging index: {pending} chunks waiting to be published")
    print("chunk index: " + (", ".join(f"{f['value']} {f['count']}" for f in facets) or "no chunks"))
    status = client.request("GET", search_url(env, f"indexers/{env['SEARCH_INDEXER']}/status")).json()
    last = status.get("lastResult") or {}
    print(f"indexer: last run {last.get('status')} ({last.get('itemsProcessed')} processed, {last.get('itemsFailed')} failed) "
          f"{last.get('startTime')} -> {last.get('endTime')}")
    return waiting + len(staged)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", action="store_true", help="start the sync now")
    parser.add_argument("--watch", action="store_true", help="repeat every minute until no file is waiting")
    parser.add_argument("--reset-state", action="store_true", help="forget what's synced (keeps the registry)")
    args = parser.parse_args()

    env = load_env()
    client = AzureClient()
    if args.reset_state:
        reset_state(env)
    if args.run:
        run_now(env)
    while True:
        waiting = show(env, client)
        if not args.watch or not waiting:
            return
        print(f"\n{waiting} file(s) still waiting; checking again in 60 s...\n")
        time.sleep(60)


if __name__ == "__main__":
    main()
