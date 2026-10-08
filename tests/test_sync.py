"""SharePoint sync: staging, publishing, deletes, edits, resumable listings and offboarding, against in-memory fakes."""

from __future__ import annotations

import copy
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

import pytest

from rag.config import Settings
from rag.search import SearchError
from rag.sharepoint import DeltaExpired, DeltaPage, GraphError
from rag.staging import REGISTRY_BLOB, StagingStore
from rag.sync import (
    FAILED,
    INDEXED,
    MAX_ATTEMPTS,
    STAGED,
    SharePointSync,
    chunk_key,
    drive_state_name,
    fiscal_year,
)

SITE = {
    "institution_key": "rbc",
    "institution_name": "RBC",
    "site_url": "https://contoso.sharepoint.com/sites/osfi-poc-rbc",
    "site_id": "",
    "group_ids": ["11111111-1111-1111-1111-111111111111"],
    "libraries": [],
}
DRIVE = "b!rbc-documents"
START = f"start:{DRIVE}"


def pdf(item_id: str, name: str | None = None, etag: str = "v1", size: int = 1000) -> dict:
    return {"id": item_id, "name": name or f"{item_id}.pdf", "file": {}, "eTag": etag, "size": size,
            "webUrl": f"https://contoso.sharepoint.com/sites/osfi-poc-rbc/Shared%20Documents/{name or item_id}.pdf"}


class FakeGraph:
    def __init__(self) -> None:
        self.pages: dict[str, DeltaPage | Exception] = {}
        self.downloads: list[str] = []
        self.missing: set[str] = set()
        self.drive_ids = [DRIVE]

    def site(self, site_id: str = "", site_url: str = "") -> dict:
        return {"id": "contoso.sharepoint.com,site,web", "webUrl": site_url}

    def drives(self, site_id: str) -> list[dict]:
        return [{"id": drive, "name": "Documents"} for drive in self.drive_ids]

    @staticmethod
    def delta_url(drive_id: str) -> str:
        return f"start:{drive_id}"

    def delta_page(self, url: str) -> DeltaPage:
        # Nothing changed: the same delta link comes back.
        page = self.pages.get(url, DeltaPage([], None, url if url.startswith("delta:") else f"delta:{url}"))
        if isinstance(page, Exception):
            raise page
        return page

    def item_title(self, drive_id: str, item_id: str) -> str | None:
        return None

    def download(self, drive_id: str, item_id: str, max_bytes: int) -> bytes:
        if item_id in self.missing:
            raise GraphError(404, "itemNotFound")
        self.downloads.append(item_id)
        return b"%PDF-1.7 " + item_id.encode()


class FakeStaging(StagingStore):
    def __init__(self) -> None:  # no storage account
        self.staged: dict[str, tuple[bytes, dict[str, str]]] = {}
        self.json: dict[str, object] = {}

    def stage(self, drive_id: str, item_id: str, data: bytes, metadata: dict[str, str]) -> None:
        self.staged[self.blob_name(drive_id, item_id)] = (data, metadata)

    def unstage(self, drive_id: str, item_id: str) -> None:
        self.staged.pop(self.blob_name(drive_id, item_id), None)

    def staged_names(self) -> list[str]:
        return list(self.staged)

    def read_json(self, name: str, default=None):
        return copy.deepcopy(self.json.get(name, default))

    def write_json(self, name: str, value) -> None:
        self.json[name] = copy.deepcopy(value)

    def delete_json(self, name: str) -> None:
        self.json.pop(name, None)


class FakeSearch:
    """The staging index the indexer writes to, and the chunk index, which the sync can only write to by key."""

    def __init__(self) -> None:
        self.staging_chunks: list[dict] = []
        self.index_docs: dict[str, dict] = {}
        self.status: dict = {"lastResult": {"status": "success", "startTime": "2000-01-01T00:00:00Z"}}
        self.indexer_runs = 0
        self._runs_indexed = 0

    @property
    def chunks(self) -> list[dict]:
        """The chunk index, which is what users search."""
        return list(self.index_docs.values())

    def staged_documents(self, limit: int = 1000) -> dict[str, int]:
        return dict(Counter(chunk["document_id"] for chunk in self.staging_chunks))

    def staged_chunks(self, document_id: str) -> list[dict]:
        return [copy.deepcopy(chunk) for chunk in self.staging_chunks if chunk["document_id"] == document_id]

    def delete_staged(self, keys: list[str]) -> int:
        doomed = set(keys)
        self.staging_chunks = [chunk for chunk in self.staging_chunks if chunk["chunk_id"] not in doomed]
        return len(keys)

    def upload_documents(self, documents: list[dict]) -> int:
        for document in documents:
            self.index_docs[document["chunk_id"]] = copy.deepcopy(document)
        return len(documents)

    def merge_documents(self, documents: list[dict]) -> int:
        merged = [document for document in documents if document["chunk_id"] in self.index_docs]
        for document in merged:
            self.index_docs[document["chunk_id"]].update(document)
        return len(merged)

    def delete_documents(self, keys: list[str]) -> int:
        for key in keys:
            self.index_docs.pop(key, None)
        return len(keys)

    def indexer_status(self) -> dict:
        return self.status

    def run_indexer(self) -> int:
        self.indexer_runs += 1
        return 202

    def index(self, staging: FakeStaging, chunks_per_file: int = 2, started: str = "2100-01-01T00:00:00Z") -> None:
        """What the indexer does with every staged blob: replace its chunks in the staging index, under new keys."""
        self._runs_indexed += 1
        for blob, (_, metadata) in staging.staged.items():
            self.staging_chunks = [c for c in self.staging_chunks if c["document_id"] != metadata["document_id"]]
            self.staging_chunks += [
                {"chunk_id": f"run{self._runs_indexed}_{metadata['document_id']}_{n}", "parent_id": blob, **metadata,
                 "chunk_text": f"{metadata['document_id']} {metadata['source_version']} part {n}",
                 "chunk_vector": [0.1 * n, 0.2], "ordinal_position": n, "page_number_from": n + 1}
                for n in reversed(range(chunks_per_file))  # any order: publishing sorts by position
            ]
        self.status = {"lastResult": {"status": "success", "startTime": started, "endTime": started, "errors": []}}


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        self.now += timedelta(seconds=1)
        return self.now


SETTINGS = Settings(
    search_endpoint="https://search.example", api_version="2026-08-01-preview", index_name="chunks",
    indexer_name="indexer", knowledge_source="reports", knowledge_base="kb", sync_max_files_per_run=25,
)


def setup(settings: Settings = SETTINGS, sites: list[dict] | None = None):
    graph, staging, search = FakeGraph(), FakeStaging(), FakeSearch()
    staging.json[REGISTRY_BLOB] = {"version": 1, "sites": sites if sites is not None else [SITE]}
    return graph, staging, search, SharePointSync(settings, graph, staging, search, clock=Clock())


def items(staging: FakeStaging, drive: str = DRIVE) -> dict:
    return staging.json[drive_state_name(drive)]["items"]


def test_new_files_are_staged_indexed_and_published_with_permissions():
    graph, staging, search, sync = setup()
    folder = {"id": "folder", "name": "2025", "folder": {}}
    graph.pages[START] = DeltaPage([pdf("A", "RBC Annual Report 2025.pdf"), pdf("B"), folder, pdf("C", "notes.docx")], None, "delta:1")

    first = sync.run()
    assert (first["staged"], first["ignored"]) == (2, 2)
    assert first["indexer_runs"] == 1
    # Blob metadata carries IDs only (it must be ASCII); display fields are added when the chunks are published.
    assert staging.staged[f"{DRIVE}/A.pdf"][1] == {
        "document_id": "A", "drive_id": DRIVE, "institution_key": "rbc", "source_version": "v1"}
    assert {item["status"] for item in items(staging).values()} == {STAGED}

    search.index(staging)
    assert len(search.staging_chunks) == 4 and search.chunks == []  # nothing reaches users before publishing

    second = sync.run()
    assert (second["indexed"], second["chunks_published"]) == (2, 4)
    assert staging.staged == {} and search.staging_chunks == []
    assert set(search.index_docs) == {chunk_key(doc, n) for doc in "AB" for n in range(2)}
    first_chunk = search.index_docs[chunk_key("A", 0)]
    assert first_chunk["GroupIds"] == SITE["group_ids"] and first_chunk["UserIds"] == []
    assert (first_chunk["doc_title"], first_chunk["institution"], first_chunk["fiscal_year"], first_chunk["source_file"]) == (
        "RBC Annual Report 2025", "RBC", "2025", "RBC Annual Report 2025.pdf")
    # Content, vectors and page provenance come across; the projection's parent key doesn't.
    assert (first_chunk["chunk_text"], first_chunk["chunk_vector"], first_chunk["page_number_from"]) == ("A v1 part 0", [0.0, 0.2], 1)
    assert "parent_id" not in first_chunk
    assert items(staging)["A"]["status"] == INDEXED and items(staging)["A"]["chunks"] == 2
    assert staging.json[drive_state_name(DRIVE)]["delta_link"] == "delta:1"


def test_nothing_is_published_while_the_indexer_runs():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A")], None, "delta:1")
    sync.run()
    search.index(staging)
    search.status = {"lastResult": {"status": "inProgress", "startTime": "2100-01-01T00:00:00Z"}}

    summary = sync.run()
    assert "indexed" not in summary and search.chunks == []  # the run may be part-way through the file
    assert items(staging)["A"]["status"] == STAGED
    assert f"{DRIVE}/A.pdf" in staging.staged and len(search.staging_chunks) == 2


def test_a_file_deleted_in_sharepoint_loses_its_chunks():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A"), pdf("B")], None, "delta:1")
    sync.run()
    search.index(staging)
    sync.run()

    graph.pages["delta:1"] = DeltaPage([{"id": "A", "deleted": {"state": "deleted"}}], None, "delta:2")
    summary = sync.run()
    assert summary["deleted"] == 1
    assert {c["document_id"] for c in search.chunks} == {"B"}
    assert set(items(staging)) == {"B"}


def test_an_edited_file_replaces_its_chunks_under_the_same_keys():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A")], None, "delta:1")
    sync.run()
    search.index(staging, chunks_per_file=3)
    sync.run()

    graph.pages["delta:1"] = DeltaPage([pdf("A", etag="v2")], None, "delta:2")
    assert sync.run()["staged"] == 1
    assert {c["source_version"] for c in search.chunks} == {"v1"}  # the old version stays until the new one is ready
    search.index(staging, chunks_per_file=2)
    sync.run()
    assert set(search.index_docs) == {chunk_key("A", 0), chunk_key("A", 1)}  # the third chunk went with v1
    assert {c["source_version"] for c in search.chunks} == {"v2"}
    assert all(c["GroupIds"] == SITE["group_ids"] for c in search.chunks)
    assert (items(staging)["A"]["version"], items(staging)["A"]["status"], items(staging)["A"]["chunks"]) == ("v2", INDEXED, 2)


def test_unchanged_files_are_not_downloaded_again():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A")], None, "delta:1")
    sync.run()
    graph.pages["delta:1"] = DeltaPage([pdf("A")], None, "delta:2")  # same eTag: e.g. a re-listed page
    assert sync.run()["unchanged"] == 1
    assert graph.downloads == ["A"]


def test_the_per_run_file_limit_resumes_from_the_same_page():
    graph, staging, search, sync = setup(Settings(**{**SETTINGS.__dict__, "sync_max_files_per_run": 2}))
    graph.pages[START] = DeltaPage([pdf("A"), pdf("B"), pdf("C")], None, "delta:1")

    assert sync.run()["staged"] == 2
    state = staging.json[drive_state_name(DRIVE)]
    assert state["cursor"] == START and "delta_link" not in state

    summary = sync.run()
    assert (summary["staged"], summary["unchanged"]) == (1, 2)
    assert staging.json[drive_state_name(DRIVE)]["delta_link"] == "delta:1"
    assert graph.downloads == ["A", "B", "C"]


def test_an_expired_delta_link_relists_the_library_and_removes_files_that_disappeared():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A"), pdf("B")], None, "delta:1")
    sync.run()
    search.index(staging)
    sync.run()

    graph.pages["delta:1"] = DeltaExpired(410, "resyncRequired")
    graph.pages[START] = DeltaPage([pdf("A")], None, "delta:9")
    summary = sync.run()
    assert (summary["full_relistings"], summary["deleted"]) == (1, 1)
    assert {c["document_id"] for c in search.chunks} == {"A"}
    assert staging.json[drive_state_name(DRIVE)]["delta_link"] == "delta:9"


def test_changing_an_institutions_groups_rewrites_its_chunks_without_reindexing():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A")], None, "delta:1")
    sync.run()
    search.index(staging)
    sync.run()

    staging.json[REGISTRY_BLOB]["sites"][0]["group_ids"] = ["22222222-2222-2222-2222-222222222222"]
    summary = sync.run()
    assert summary["chunks_retagged"] == 2
    assert all(c["GroupIds"] == ["22222222-2222-2222-2222-222222222222"] for c in search.chunks)
    assert graph.downloads == ["A"]


def test_an_institution_removed_from_the_registry_is_offboarded():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A")], None, "delta:1")
    sync.run()
    search.index(staging)
    sync.run()

    staging.json[REGISTRY_BLOB]["sites"] = [{**SITE, "institution_key": "td", "institution_name": "TD"}]
    graph.drive_ids = ["b!td-documents"]
    summary = sync.run()
    assert summary["institutions_removed"] == 1
    assert search.chunks == []
    assert drive_state_name(DRIVE) not in staging.json


def test_without_a_registry_nothing_is_touched():
    graph, staging, search, sync = setup(sites=[])
    search.index_docs = {"x": {"chunk_id": "x", "document_id": "A", "GroupIds": ["g"]}}
    assert "skipped" in sync.run()
    assert len(search.chunks) == 1


def test_an_indexer_error_fails_the_file_and_a_later_run_retries_it():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A")], None, "delta:1")
    sync.run()
    search.status = {"lastResult": {
        "status": "success", "startTime": "2100-01-01T00:00:00Z", "endTime": "2100-01-01T00:01:00Z",
        "errors": [{"key": f"localId=https://stage.blob.core.windows.net/staging/{DRIVE}/A.pdf",
                    "errorMessage": "Could not parse document"}],
    }}

    sync.run()
    record = items(staging)["A"]
    assert (record["status"], record["error"]) == (FAILED, "Could not parse document")
    assert staging.staged == {}

    # The retry is staged after the failed run, so that run says nothing about it.
    search.status = {"lastResult": {"status": "success", "startTime": "2026-10-01T11:00:00Z", "errors": []}}
    assert sync.run()["retried"] == 1
    assert items(staging)["A"]["status"] == STAGED and items(staging)["A"]["attempts"] == 2


def test_failed_files_stop_retrying_after_the_limit():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A")], None, "delta:1")
    sync.run()
    staging.json[drive_state_name(DRIVE)]["items"]["A"].update(status=FAILED, attempts=MAX_ATTEMPTS)
    assert "retried" not in sync.run()
    assert graph.downloads == ["A"]


def test_a_file_over_the_indexer_limit_fails_without_being_downloaded():
    graph, staging, search, sync = setup(Settings(**{**SETTINGS.__dict__, "sync_max_file_bytes": 500}))
    graph.pages[START] = DeltaPage([pdf("A", size=501)], None, "delta:1")
    assert sync.run()["failed"] == 1
    assert graph.downloads == [] and staging.staged == {}
    assert items(staging)["A"]["attempts"] == MAX_ATTEMPTS


def test_one_sites_failure_does_not_stop_the_others():
    graph, staging, search, sync = setup(sites=[SITE, {**SITE, "institution_key": "td"}])
    graph.pages[START] = GraphError(403, "accessDenied")
    summary = sync.run()
    assert [error["site"] for error in summary["errors"]] == ["rbc", "td"]
    assert "403" in summary["errors"][0]["error"]


def test_staging_chunks_of_deleted_or_replaced_versions_are_discarded():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A"), pdf("B")], None, "delta:1")
    sync.run()
    search.index(staging)

    # Before the next run publishes them: A is deleted in SharePoint, and B is edited.
    graph.pages["delta:1"] = DeltaPage([{"id": "A", "deleted": {}}, pdf("B", etag="v2")], None, "delta:2")
    summary = sync.run()
    assert summary["staged_chunks_discarded"] == 4 and search.staging_chunks == []
    assert search.chunks == []
    assert set(items(staging)) == {"B"} and items(staging)["B"]["status"] == STAGED
    assert summary["indexer_runs"] == 1  # for B's new version


def test_the_chunk_count_is_saved_before_the_staging_copies_go():
    """The count is the only way back to published chunks, so a failure after publishing must not lose it."""
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A")], None, "delta:1")
    sync.run()
    search.index(staging)
    delete_staged = search.delete_staged

    def broken(*_args, **_kwargs):
        raise SearchError(503, "busy")

    search.delete_staged = broken
    with pytest.raises(SearchError):
        sync.run()
    assert (items(staging)["A"]["status"], items(staging)["A"]["chunks"]) == (INDEXED, 2)

    search.delete_staged = delete_staged
    assert sync.run()["staged_chunks_discarded"] == 2
    assert staging.staged == {}
    graph.pages["delta:1"] = DeltaPage([{"id": "A", "deleted": {}}], None, "delta:2")
    sync.run()
    assert search.chunks == []


def test_chunk_keys_are_valid_and_distinct_per_document():
    keys = {chunk_key(document_id, 0) for document_id in ("01ABC", "01ABD", "b!x.y", "01ABC_0")}
    assert len(keys) == 4
    assert all(re.fullmatch(r"[A-Za-z0-9_\-=]+", key) for key in keys)


@pytest.mark.parametrize(
    ("texts", "expected"),
    [(("RBC Annual Report 2025.pdf",), "2025"), ((None, "bmo_ar2025.pdf"), "2025"), (("Scotiabank.pdf",), None),
     (("ID 120251.pdf",), None)],
)
def test_fiscal_year_comes_from_the_title_or_file_name(texts, expected):
    assert fiscal_year(*texts) == expected


def test_search_errors_while_finishing_surface_to_the_caller():
    graph, staging, search, sync = setup()
    graph.pages[START] = DeltaPage([pdf("A")], None, "delta:1")
    sync.run()

    def broken(*_args, **_kwargs):
        raise SearchError(503, "busy")

    search.staged_documents = broken
    with pytest.raises(SearchError):
        sync.run()
