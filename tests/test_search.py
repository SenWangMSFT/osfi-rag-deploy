"""Search calls carry the user's token (bare); the sync reads only the staging index and writes chunks by key."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from rag.config import Settings
from rag.search import SearchError, SearchService, odata_literal

SETTINGS = Settings(
    search_endpoint="https://srch.search.windows.net", api_version="2026-08-01-preview", index_name="chunks",
    indexer_name="indexer", knowledge_source="reports", knowledge_base="kb", staging_index_name="staging",
)


def service(*responses):
    session = Mock()
    session.post.side_effect = [Mock(status_code=status, json=Mock(return_value=body), text="") for status, body in responses]
    session.get.side_effect = [Mock(status_code=status, json=Mock(return_value=body), text="") for status, body in responses]
    credential = Mock()
    credential.get_token.return_value = Mock(token="app-token", expires_on=9_999_999_999)
    return SearchService(SETTINGS, credential, session), session


def test_retrieve_sends_the_users_token_bare_alongside_the_apps():
    search, session = service((200, {"response": [], "references": []}))
    search.retrieve("Question?", [], user_token="user-token")
    headers = session.post.call_args.kwargs["headers"]
    assert headers["Authorization"] == "Bearer app-token"
    assert headers["x-ms-query-source-authorization"] == "user-token"
    assert "x-ms-enable-elevated-read" not in headers


def test_the_sync_reads_whole_chunks_from_the_staging_index_with_its_own_identity_only():
    full_page = [{"chunk_id": f"c{n}", "@search.score": 1.0} for n in range(100)]
    search, session = service((200, {"value": full_page}), (200, {"value": [{"chunk_id": "last"}]}))
    chunks = search.staged_chunks("it's")
    assert len(chunks) == 101 and "@search.score" not in chunks[0]
    request = session.post.call_args.kwargs
    assert session.post.call_args.args[0].startswith("https://srch.search.windows.net/indexes/staging/docs/search")
    assert request["json"]["filter"] == "document_id eq 'it''s'"
    assert "select" not in request["json"]  # vectors included
    assert (request["json"]["orderby"], request["json"]["skip"]) == ("chunk_id", 100)  # stable paging
    assert "x-ms-query-source-authorization" not in request["headers"]
    assert "x-ms-enable-elevated-read" not in request["headers"]  # Search refuses it for app-only tokens


def test_uploads_go_to_the_chunk_index_in_small_batches_and_report_failures():
    search, session = service(
        (200, {"value": [{"key": str(n), "status": True} for n in range(100)]}),
        (207, {"value": [{"key": "100", "status": False, "statusCode": 400, "errorMessage": "bad"}]}),
    )
    with pytest.raises(SearchError):
        search.upload_documents([{"chunk_id": str(n)} for n in range(101)])
    first = session.post.call_args_list[0]
    assert first.args[0].startswith("https://srch.search.windows.net/indexes/chunks/docs/index")
    assert len(first.kwargs["json"]["value"]) == 100
    assert first.kwargs["json"]["value"][0] == {"@search.action": "upload", "chunk_id": "0"}


def test_document_lookups_escape_ids_and_return_none_when_the_user_sees_nothing():
    assert odata_literal("it's") == "'it''s'"
    search, session = service((200, {"value": []}))
    assert search.find_document("01ABC", "user-token") is None
    body = session.post.call_args.kwargs["json"]
    assert body["filter"] == "document_id eq '01ABC'"
    assert session.post.call_args.kwargs["headers"]["x-ms-query-source-authorization"] == "user-token"


def test_the_library_is_one_row_per_document_with_chunk_counts():
    search, session = service(
        (200, {"@search.facets": {"document_id": [{"value": "01A", "count": 5}]}}),
        (200, {"value": [{"document_id": "01A", "doc_title": "A"}]}),
    )
    assert search.list_documents("user-token") == [{"document_id": "01A", "doc_title": "A", "chunks": 5}]
    assert session.post.call_args.kwargs["json"]["filter"] == "ordinal_position eq 0"


def test_merges_skip_chunks_that_were_deleted_meanwhile_but_report_other_failures():
    search, _ = service(
        (207, {"value": [{"key": "a", "status": True}, {"key": "b", "status": False, "statusCode": 404}]}),
        (207, {"value": [{"key": "c", "status": False, "statusCode": 400, "errorMessage": "bad"}]}),
    )
    assert search.merge_documents([{"chunk_id": "a"}, {"chunk_id": "b"}]) == 1
    with pytest.raises(SearchError):
        search.merge_documents([{"chunk_id": "c"}])


def test_citation_lookups_stay_on_this_index_and_need_the_chunk_to_be_visible_to_the_user():
    search, session = service()
    session.get.side_effect = None
    session.get.return_value = Mock(status_code=200, json=Mock(return_value={"chunk_id": "c 1"}))
    session.post.side_effect = None
    session.post.return_value = Mock(status_code=200, json=Mock(return_value={"value": [{"chunk_id": "c 1"}]}))
    url = "https://srch.search.windows.net/indexes/chunks/docs/c%201?api-version=x"

    assert search.get_citation_document(url, user_token="user-token") == {"chunk_id": "c 1"}
    assert session.get.call_args.kwargs["headers"]["x-ms-query-source-authorization"] == "user-token"
    visibility = session.post.call_args.kwargs
    assert visibility["json"]["filter"] == "chunk_id eq 'c 1'"
    assert visibility["headers"]["x-ms-query-source-authorization"] == "user-token"

    # A citationUrl from someone else's answer: the lookup works, but the user's own search can't see the chunk.
    session.post.return_value = Mock(status_code=200, json=Mock(return_value={"value": []}))
    with pytest.raises(SearchError) as error:
        search.get_citation_document(url, user_token="user-token")
    assert error.value.status == 404
    with pytest.raises(ValueError):
        search.get_citation_document("https://evil.example/indexes/chunks/docs/c", user_token="user-token")
