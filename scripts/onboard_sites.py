"""Publishes the site registry (config/institutions.csv) to the SharePoint sync.

The sync reads registry.json from the sync-state container on every run, so adding, changing or removing a row takes
effect on the next run without a deployment:
- a new row: the next run lists the whole site and indexes every PDF;
- different group_ids: the next run rewrites the permissions on that institution's chunks, without re-indexing;
- a removed row: the next run deletes that institution's chunks.
The Function App's identity also needs read on each site: scripts/grant_sharepoint_access.ps1 (tenant admin).

    python scripts/onboard_sites.py           # validate and publish
    python scripts/onboard_sites.py --check   # validate only
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from azure.core.exceptions import HttpResponseError
from azure.identity import AzureCliCredential
from azure.storage.blob import BlobServiceClient, ContentSettings

from _common import ROOT, load_env

REGISTRY = ROOT / "config" / "institutions.csv"
_GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_KEY = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


def _split(value: str | None) -> list[str]:
    return [part for part in re.split(r"[;\s]+", value or "") if part]


def load_registry(path: Path) -> list[dict]:
    """Rows of the CSV as the sync expects them; raises ValueError listing every problem."""
    with path.open(encoding="utf-8-sig") as file:
        rows = list(csv.DictReader(file))
    problems: list[str] = []
    sites: list[dict] = []
    seen: set[str] = set()
    for line, row in enumerate(rows, start=2):
        key = (row.get("institution_key") or "").strip()
        name = (row.get("institution_name") or "").strip()
        url = (row.get("site_url") or "").strip()
        site_id = (row.get("site_id") or "").strip()
        groups = _split(row.get("group_ids"))
        if not _KEY.match(key):
            problems.append(f"line {line}: institution_key {key!r} must be lowercase letters, digits and hyphens")
        elif key in seen:
            problems.append(f"line {line}: institution_key {key!r} appears twice")
        seen.add(key)
        if not name:
            problems.append(f"line {line}: institution_name is empty")
        parts = urlsplit(url)
        if not site_id and (parts.scheme != "https" or not (parts.hostname or "").endswith(".sharepoint.com")):
            problems.append(f"line {line}: site_url must be an https://<tenant>.sharepoint.com URL (or set site_id)")
        if not groups:
            # Chunks without groups would be visible to nobody, which is safe but certainly a mistake.
            problems.append(f"line {line}: group_ids is empty")
        problems.extend(f"line {line}: group ID {g!r} isn't an Entra object ID" for g in groups if not _GUID.match(g))
        sites.append(
            {
                "institution_key": key,
                "institution_name": name,
                "site_url": url,
                "site_id": site_id,
                "group_ids": groups,
                "libraries": _split(row.get("libraries")),
                "language": (row.get("language") or "en").strip(),
            }
        )
    if problems:
        raise ValueError("\n".join(problems))
    return sites


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="validate config/institutions.csv without publishing")
    args = parser.parse_args()

    try:
        sites = load_registry(REGISTRY)
    except (OSError, ValueError) as exc:
        sys.exit(f"{REGISTRY.relative_to(ROOT)}:\n{exc}")
    for site in sites:
        where = site["site_url"] or site["site_id"]
        note = "" if site["site_id"] else "  (no site_id yet: run scripts/grant_sharepoint_access.ps1)"
        print(f"{site['institution_key']:<18} {site['institution_name']:<20} {len(site['group_ids'])} group(s)  {where}{note}")
    if args.check:
        return

    env = load_env()
    container = BlobServiceClient(env["STAGING_BLOB_ENDPOINT"], credential=AzureCliCredential()).get_container_client(
        env["SYNC_STATE_CONTAINER"]
    )
    body = json.dumps({"version": 1, "sites": sites}, indent=1).encode("utf-8")
    # A role assignment made by a fresh deployment can take a few minutes to apply.
    for attempt in range(1, 11):
        try:
            container.upload_blob(
                "registry.json", body, overwrite=True, content_settings=ContentSettings(content_type="application/json")
            )
            break
        except HttpResponseError as exc:
            if exc.status_code != 403 or attempt == 10:
                raise
            print("  waiting for the Storage Blob Data Contributor role to apply...")
            time.sleep(30)
    print(f"\nPublished {len(sites)} sites to {env['SYNC_STATE_CONTAINER']}/registry.json. The next sync run uses it.")


if __name__ == "__main__":
    main()
