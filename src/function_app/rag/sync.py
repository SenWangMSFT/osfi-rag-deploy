"""SharePoint -> Azure AI Search sync.

Every run, for each site in the registry:
1. Graph delta per document library. New or edited PDFs are copied to the staging container; files deleted in
   SharePoint lose their chunks.
2. The indexer turns staged files into chunks with the existing skillset and writes them to the staging index, which
   has no permission filtering and which no user queries.
3. Publishing: once the indexer is idle, the job copies each staged file's chunks into the chunk index with the
   institution's group IDs and the document's display fields, then deletes the staged file and its staging chunks.

The managed identity can't query the chunk index (it's app-only, so permission filtering hides every chunk from it).
Chunk keys are therefore derived from the document ID and the chunk's position, and the sync state keeps each
document's chunk count: that is how the job updates and deletes chunks later.
"""

from __future__ import annotations

import base64
import logging
import re
from collections import Counter
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any

from .config import Settings
from .search import KEY_FIELD, SearchService
from .sharepoint import DeltaExpired, GraphClient, GraphError
from .staging import REGISTRY_BLOB, StagingStore

SITES_STATE = "sites.json"
SUPPORTED_EXTENSIONS = (".pdf",)
STAGED, INDEXED, FAILED = "staged", "indexed", "failed"
MAX_ATTEMPTS = 3
# Finishing cycles after an indexer run that produced neither chunks nor an error, before giving up on a file.
MAX_EMPTY_CHECKS = 2
# Staging-index fields that only the index projection uses (its parent key).
STAGING_ONLY_FIELDS = frozenset({"parent_id"})
_YEAR = re.compile(r"(?<!\d)(20\d{2})(?!\d)")


def drive_state_name(drive_id: str) -> str:
    return f"drives/{drive_id}.json"


def chunk_key(document_id: str, position: int) -> str:
    """The chunk index key of a document's chunk. Keys allow only letters, digits, '_', '-' and '='."""
    return f"{base64.urlsafe_b64encode(document_id.encode()).decode().rstrip('=')}_{position}"


def fiscal_year(*texts: str | None) -> str | None:
    for text in texts:
        match = _YEAR.search(text or "")
        if match:
            return match.group(1)
    return None


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class SharePointSync:
    def __init__(
        self,
        settings: Settings,
        graph: GraphClient,
        staging: StagingStore,
        search: SearchService,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._settings = settings
        self._graph = graph
        self._staging = staging
        self._search = search
        self._clock = clock
        self._counts: Counter[str] = Counter()
        self._errors: list[dict[str, str]] = []

    def run(self) -> dict[str, Any]:
        self._counts = Counter()
        self._errors = []
        registry = self._staging.read_json(REGISTRY_BLOB)
        sites = (registry or {}).get("sites") or []
        if not sites:
            # No registry means nothing is onboarded yet; never treat it as "every site was removed".
            return {"skipped": "no sites registered (scripts/onboard_sites.py)"}

        sites_state: dict[str, Any] = self._staging.read_json(SITES_STATE, {})
        budget = self._settings.sync_max_files_per_run
        for site in sites:
            try:
                budget -= self._sync_site(site, sites_state, budget)
            except Exception as exc:  # noqa: BLE001 - one site's failure must not stop the others
                logging.exception("Sync failed for %s", site.get("institution_key"))
                self._errors.append({"site": site.get("institution_key", "?"), "error": str(exc)[:500]})
        self._offboard(sites_state, {site["institution_key"] for site in sites})
        self._staging.write_json(SITES_STATE, sites_state)

        states = {
            drive_id: self._staging.read_json(drive_state_name(drive_id), {"items": {}})
            for info in sites_state.values()
            for drive_id in info.get("drives", [])
        }
        self._finish({site["institution_key"]: site for site in sites}, states)
        return {**dict(self._counts), "errors": self._errors}

    def _sync_site(self, site: dict[str, Any], sites_state: dict[str, Any], budget: int) -> int:
        key = site["institution_key"]
        site_info = self._graph.site(site_id=site.get("site_id", ""), site_url=site.get("site_url", ""))
        drives = self._graph.drives(site_info["id"])
        wanted = {name.lower() for name in site.get("libraries") or []}
        if wanted:
            drives = [drive for drive in drives if drive.get("name", "").lower() in wanted]

        known = sites_state.setdefault(key, {"drives": [], "group_ids": None})
        group_ids = sorted(site["group_ids"])
        if known.get("group_ids") not in (None, group_ids):
            self._counts["chunks_retagged"] += self._retag(known.get("drives", []), group_ids)
        known["group_ids"] = group_ids

        current = [drive["id"] for drive in drives]
        for drive_id in set(known.get("drives", [])) - set(current):
            self._drop_drive(drive_id)
        known["drives"] = current

        staged = 0
        for drive_id in current:
            if staged >= budget:
                break  # the next run continues from each library's saved position
            staged += self._sync_drive(site, drive_id, budget - staged)
        return staged

    def _sync_drive(self, site: dict[str, Any], drive_id: str, budget: int) -> int:
        name = drive_state_name(drive_id)
        state: dict[str, Any] = self._staging.read_json(name, {"items": {}})
        start = self._graph.delta_url(drive_id)
        url: str | None = state.get("cursor") or state.get("delta_link") or start
        if url == start:
            # A full listing: anything known but not listed was deleted while no delta link covered it.
            state.setdefault("seen", [])
        staged = 0
        try:
            while url:
                try:
                    page = self._graph.delta_page(url)
                except DeltaExpired:
                    self._counts["full_relistings"] += 1
                    url = start
                    state.update(cursor=None, delta_link=None, seen=[])
                    continue
                for item in page.items:
                    if staged >= budget:
                        # Read this page again next time; items already handled come back as unchanged.
                        state["cursor"] = url
                        return staged
                    outcome = self._apply(site, drive_id, item, state)
                    self._counts[outcome] += 1
                    staged += outcome == "staged"
                    if "seen" in state and "file" in item and "deleted" not in item:
                        state["seen"].append(item["id"])
                if page.next_link:
                    url = state["cursor"] = page.next_link
                    continue
                state.update(cursor=None, delta_link=page.delta_link)
                url = None
                if "seen" in state:
                    seen = set(state.pop("seen"))
                    for item_id in [item_id for item_id in state["items"] if item_id not in seen]:
                        self._remove(drive_id, item_id, state)
                        self._counts["deleted"] += 1
            staged += self._retry_failed(drive_id, state, budget - staged)
        finally:
            self._staging.write_json(name, state)
        return staged

    def _retry_failed(self, drive_id: str, state: dict[str, Any], budget: int) -> int:
        """Stages failed files again (a transient indexer error, for example) until they reach MAX_ATTEMPTS."""
        retried = 0
        for item_id, record in list(state["items"].items()):
            if retried >= budget:
                break
            if record.get("status") != FAILED or record.get("attempts", 0) >= MAX_ATTEMPTS:
                continue
            try:
                data = self._graph.download(drive_id, item_id, self._settings.sync_max_file_bytes)
            except GraphError as exc:
                if exc.status == 404:
                    self._remove(drive_id, item_id, state)
                    self._counts["deleted"] += 1
                    continue
                raise
            self._stage(drive_id, item_id, data, record)
            retried += 1
            self._counts["retried"] += 1
        return retried

    def _stage(self, drive_id: str, item_id: str, data: bytes, record: dict[str, Any]) -> None:
        self._staging.stage(
            drive_id,
            item_id,
            data,
            {
                "document_id": item_id,
                "drive_id": drive_id,
                "institution_key": record["institution_key"],
                "source_version": record["version"],
            },
        )
        record.pop("error", None)
        record.pop("empty_checks", None)
        record.update(status=STAGED, staged_at=self._clock().isoformat(), attempts=record.get("attempts", 0) + 1)

    def _apply(self, site: dict[str, Any], drive_id: str, item: dict[str, Any], state: dict[str, Any]) -> str:
        item_id = item["id"]
        known = state["items"].get(item_id)
        # Graph facets mark what an item is; check for their presence, since they can be empty objects.
        if "deleted" in item:
            if known:
                self._remove(drive_id, item_id, state)
                return "deleted"
            return "ignored"
        if "file" not in item:
            return "ignored"  # folders and the library root
        name = item.get("name") or ""
        if not name.lower().endswith(SUPPORTED_EXTENSIONS):
            if known:  # e.g. renamed from .pdf to something the indexer doesn't read
                self._remove(drive_id, item_id, state)
                return "deleted"
            return "ignored"

        version = item.get("eTag") or item.get("lastModifiedDateTime") or ""
        same_version = bool(known) and known.get("version") == version
        if same_version and (known["status"] in (STAGED, INDEXED) or known.get("attempts", 0) >= MAX_ATTEMPTS):
            return "unchanged"

        record: dict[str, Any] = {
            "name": name,
            "version": version,
            "web_url": item.get("webUrl"),
            "size": item.get("size"),
            "institution_key": site["institution_key"],
            "attempts": known.get("attempts", 0) if same_version else 0,
            # The published version's chunks stay searchable until the new version replaces them.
            "chunks": (known or {}).get("chunks", 0),
        }
        state["items"][item_id] = record
        if (item.get("size") or 0) > self._settings.sync_max_file_bytes:
            # Final until the file changes: retrying can't make it smaller.
            record.update(
                status=FAILED,
                attempts=MAX_ATTEMPTS,
                error=f"Larger than the indexer's {self._settings.sync_max_file_bytes // (1 << 20)} MB limit.",
            )
            return "failed"
        data = self._graph.download(drive_id, item_id, self._settings.sync_max_file_bytes)
        record["title"] = self._graph.item_title(drive_id, item_id)
        self._stage(drive_id, item_id, data, record)
        return "staged"

    def _remove(self, drive_id: str, item_id: str, state: dict[str, Any]) -> None:
        record = state["items"].get(item_id) or {}
        keys = [chunk_key(item_id, n) for n in range(record.get("chunks") or 0)]
        if keys:
            self._counts["chunks_deleted"] += self._search.delete_documents(keys)
        self._staging.unstage(drive_id, item_id)  # its staging chunks, if any, go in the next _finish
        state["items"].pop(item_id, None)

    def _drop_drive(self, drive_id: str) -> None:
        state = self._staging.read_json(drive_state_name(drive_id), {"items": {}})
        for item_id in list(state.get("items", {})):
            self._remove(drive_id, item_id, state)
            self._counts["deleted"] += 1
        self._staging.delete_json(drive_state_name(drive_id))

    def _offboard(self, sites_state: dict[str, Any], active: set[str]) -> None:
        for key in [key for key in sites_state if key not in active]:
            for drive_id in sites_state[key].get("drives", []):
                self._drop_drive(drive_id)
            del sites_state[key]
            self._counts["institutions_removed"] += 1

    def _retag(self, drive_ids: list[str], group_ids: list[str]) -> int:
        """Rewrites the permissions on every published chunk of these libraries, without re-indexing."""
        keys = [
            chunk_key(item_id, n)
            for drive_id in drive_ids
            for item_id, record in self._staging.read_json(drive_state_name(drive_id), {}).get("items", {}).items()
            for n in range(record.get("chunks") or 0)
        ]
        return self._search.merge_documents([{KEY_FIELD: key, "GroupIds": group_ids} for key in keys])

    def _finish(self, sites: dict[str, dict[str, Any]], states: dict[str, dict[str, Any]]) -> None:
        """Publishes the files the indexer has finished, fails the ones it couldn't read, and runs it for the rest."""
        records = {
            item_id: (drive_id, record)
            for drive_id, state in states.items()
            for item_id, record in state.get("items", {}).items()
        }
        waiting = {item_id: entry for item_id, entry in records.items() if entry[1].get("status") == STAGED}
        status = self._search.indexer_status()
        if (status.get("lastResult") or {}).get("status") == "inProgress":
            return  # the indexer may be part-way through a document's chunks; finish on a later run

        leftovers: list[str] = []
        for document_id in self._search.staged_documents():
            chunks = self._search.staged_chunks(document_id)
            drive_id, record = records.get(document_id, (None, None))
            site = sites.get(record["institution_key"]) if document_id in waiting else None
            current = [c for c in chunks if site and c.get("source_version") == record["version"]]
            current_keys = {chunk[KEY_FIELD] for chunk in current}
            # An older version's chunks, or chunks of a file deleted or offboarded after it was staged.
            leftovers += [chunk[KEY_FIELD] for chunk in chunks if chunk[KEY_FIELD] not in current_keys]
            if not current:
                if record and document_id not in waiting:
                    self._staging.unstage(drive_id, document_id)  # published before a failure left its copy
                continue
            count = self._publish(document_id, record, site, current)
            record.update(status=INDEXED, chunks=count, indexed_at=self._clock().isoformat())
            record.pop("error", None)
            record.pop("empty_checks", None)
            # Saved before the staging copies go, so the chunk count is never lost.
            self._staging.write_json(drive_state_name(drive_id), states[drive_id])
            self._search.delete_staged(sorted(current_keys))
            self._staging.unstage(drive_id, document_id)
            self._counts["indexed"] += 1
            self._counts["chunks_published"] += count
            del waiting[document_id]
        if leftovers:
            self._counts["staged_chunks_discarded"] += self._search.delete_staged(leftovers)

        changed: set[str] = set()
        for document_id, (drive_id, record) in waiting.items():
            if not self._ran_since(status, record.get("staged_at")):
                continue
            error = self._indexer_error(status, document_id, record.get("staged_at"))
            record["empty_checks"] = record.get("empty_checks", 0) + 1
            if error or record["empty_checks"] >= MAX_EMPTY_CHECKS:
                record.update(status=FAILED, error=error or "The indexer produced no chunks for this file.")
                self._staging.unstage(drive_id, document_id)
                self._counts["failed"] += 1
            changed.add(drive_id)
        for drive_id in changed:
            self._staging.write_json(drive_state_name(drive_id), states[drive_id])
        if any(record.get("status") == STAGED for _, record in waiting.values()):
            self._search.run_indexer()
            self._counts["indexer_runs"] += 1

    def _publish(self, document_id: str, record: dict[str, Any], site: dict[str, Any], chunks: list[dict]) -> int:
        """Writes a document's chunks to the chunk index, in reading order, and returns how many there are."""
        ordered = sorted(
            chunks,
            key=lambda chunk: (chunk.get("ordinal_position") is None, chunk.get("ordinal_position") or 0, chunk[KEY_FIELD]),
        )
        fields = self._chunk_fields(record, site)
        documents = [
            {
                **{name: value for name, value in chunk.items() if name not in STAGING_ONLY_FIELDS},
                **fields,
                KEY_FIELD: chunk_key(document_id, position),
            }
            for position, chunk in enumerate(ordered)
        ]
        self._search.upload_documents(documents)
        # An edit can leave fewer chunks than the version it replaces.
        stale = [chunk_key(document_id, n) for n in range(len(documents), record.get("chunks") or 0)]
        if stale:
            self._search.delete_documents(stale)
        return len(documents)

    @staticmethod
    def _chunk_fields(record: dict[str, Any], site: dict[str, Any]) -> dict[str, Any]:
        stem = PurePosixPath(record["name"]).stem
        return {
            "GroupIds": sorted(site["group_ids"]),
            "UserIds": [],
            "doc_title": record.get("title") or stem,
            "institution": site.get("institution_name") or site["institution_key"],
            "fiscal_year": fiscal_year(record.get("title"), record["name"]),
            "source_file": record["name"],
            "source_url": record.get("web_url"),
        }

    @staticmethod
    def _runs(status: dict[str, Any]) -> list[dict[str, Any]]:
        last = status.get("lastResult")
        history = status.get("executionHistory") or []
        return ([last] if last else []) + [run for run in history if run is not last]

    def _ran_since(self, status: dict[str, Any], staged_at: str | None) -> bool:
        """True once a whole indexer run started after the file was staged, so it should have read it."""
        since = _parse_time(staged_at)
        return any(
            run.get("status") != "inProgress" and since and (_parse_time(run.get("startTime")) or since) > since
            for run in self._runs(status)
        )

    def _indexer_error(self, status: dict[str, Any], item_id: str, staged_at: str | None) -> str | None:
        since = _parse_time(staged_at)
        for run in self._runs(status):
            ended = _parse_time(run.get("endTime"))
            if since and ended and ended < since:
                continue
            for error in run.get("errors") or []:
                where = " ".join(str(error.get(field) or "") for field in ("key", "name", "details"))
                if item_id in where:
                    return str(error.get("errorMessage") or error.get("details") or "Indexer error")[:500]
        return None
