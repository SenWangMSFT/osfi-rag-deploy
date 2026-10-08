"""The API answers only with a signed-in user's search token, and every lookup runs with that token."""

from __future__ import annotations

import json
import time
from unittest.mock import Mock

import azure.functions as func
import pytest

import function_app
from helpers import USER_TOKEN, fake_jwt, user_headers
from rag.auth import UserTokenError, user_token
from rag.docs import DocumentService, content_disposition
from rag.search import SearchError
from rag.sharepoint import GraphError


def call(route, path: str, headers: dict[str, str] | None = None, params: dict | None = None, name: str | None = None):
    request = func.HttpRequest(
        method="GET", url=f"http://localhost{path}", headers=headers or {}, params=params or {},
        route_params={"name": name} if name is not None else {}, body=b"",
    )
    response = route.build().get_user_function()(request)
    body = response.get_body()
    is_json = response.mimetype == "application/json"
    return response, (json.loads(body) if is_json else body)


@pytest.mark.parametrize(
    ("headers", "code"),
    [
        ({}, "sign_in_required"),
        (user_headers("not-a-jwt"), "invalid_token"),
        (user_headers(fake_jwt({"aud": "https://graph.microsoft.com", "exp": time.time() + 600})), "invalid_token"),
        (user_headers(fake_jwt({"aud": "https://search.azure.com", "exp": time.time() + 10})), "token_expired"),
        (user_headers(fake_jwt({"aud": "https://search.azure.com"})), "token_expired"),
    ],
)
def test_requests_without_a_usable_user_token_are_refused(headers, code):
    with pytest.raises(UserTokenError) as error:
        user_token(headers)
    assert error.value.code == code
    for route, path, name in (
        (function_app.list_documents, "/api/documents", None),
        (function_app.open_document, "/api/docs/01ABC", "01ABC"),
        (function_app.citation_preview, "/api/citation", None),
    ):
        response, data = call(route, path, headers, name=name)
        assert (response.status_code, data["code"]) == (401, code)


def test_a_search_token_is_accepted_and_returned_bare():
    assert user_token(user_headers()) == USER_TOKEN
    app_id_audience = fake_jwt({"aud": "880da380-985e-4198-81b9-e05b1cc53158", "exp": time.time() + 600})
    assert user_token(user_headers(app_id_audience)) == app_id_audience


def test_ask_without_a_user_token_never_reaches_search(monkeypatch):
    search = Mock()
    monkeypatch.setattr(function_app, "_services", lambda: (search, None))
    request = func.HttpRequest(method="POST", url="http://localhost/api/ask", body=json.dumps({"question": "Q?"}).encode())
    response = function_app.ask.build().get_user_function()(request)
    assert response.status_code == 401
    assert json.loads(response.get_body())["code"] == "sign_in_required"
    search.retrieve.assert_not_called()


def test_search_rejecting_the_user_token_is_a_401_not_a_502(monkeypatch):
    search = Mock()
    search.retrieve.side_effect = SearchError(401, "Invalid header 'x-ms-query-source-authorization'")
    monkeypatch.setattr(function_app, "_services", lambda: (search, None))
    request = func.HttpRequest(
        method="POST", url="http://localhost/api/ask", headers=user_headers(), body=json.dumps({"question": "Q?"}).encode()
    )
    response = function_app.ask.build().get_user_function()(request)
    assert response.status_code == 401
    assert json.loads(response.get_body())["code"] == "invalid_token"


def test_the_library_lists_only_what_the_users_token_returns(monkeypatch):
    search = Mock()
    search.list_documents.return_value = [
        {"document_id": "01TD", "doc_title": "TD 2025", "institution": "TD", "fiscal_year": "2025", "chunks": 9},
        {"document_id": "01RBC", "doc_title": "RBC 2025", "institution": "RBC", "fiscal_year": "2025", "chunks": 7},
    ]
    monkeypatch.setattr(function_app, "_services", lambda: (search, None))
    response, data = call(function_app.list_documents, "/api/documents", user_headers())
    assert response.status_code == 200
    search.list_documents.assert_called_once_with(USER_TOKEN)
    assert [(doc["file"], doc["title"], doc["chunks"]) for doc in data["documents"]] == [("01RBC", "RBC 2025", 7), ("01TD", "TD 2025", 9)]


def documents_service(found: dict | None, content: bytes | Exception = b"%PDF-1.7"):
    search, graph = Mock(), Mock()
    search.find_document.return_value = found
    if isinstance(content, Exception):
        graph.download.side_effect = content
    else:
        graph.download.return_value = content
    return search, graph, DocumentService(search, graph, max_bytes=1000)


FOUND = {"document_id": "01RBC", "drive_id": "b!drive", "source_file": "Rapport annuel 2025 – RBC.pdf"}


def test_a_pdf_streams_only_after_the_users_own_lookup_finds_it(monkeypatch):
    search, graph, docs = documents_service(FOUND)
    monkeypatch.setattr(function_app, "_services", lambda: (search, docs))
    response, body = call(function_app.open_document, "/api/docs/01RBC", user_headers(), name="01RBC")

    assert response.status_code == 200 and body == b"%PDF-1.7"
    assert response.mimetype == "application/pdf"
    assert response.headers["Content-Disposition"].startswith('inline; filename="Rapport annuel 2025 _ RBC.pdf"')
    search.find_document.assert_called_once_with("01RBC", USER_TOKEN)
    graph.download.assert_called_once_with("b!drive", "01RBC", 1000)


def test_a_document_the_user_cannot_see_is_indistinguishable_from_a_missing_one(monkeypatch):
    search, graph, docs = documents_service(None)
    monkeypatch.setattr(function_app, "_services", lambda: (search, docs))
    response, data = call(function_app.open_document, "/api/docs/01TD", user_headers(), name="01TD")
    assert (response.status_code, data["error"]) == (404, "Document not found.")
    graph.download.assert_not_called()


def test_the_viewer_gets_a_same_origin_url_and_bad_ids_are_rejected(monkeypatch):
    search, graph, docs = documents_service(FOUND)
    monkeypatch.setattr(function_app, "_services", lambda: (search, docs))
    response, data = call(function_app.open_document, "/api/docs/01RBC", user_headers(), {"format": "json"}, name="01RBC")
    assert (response.status_code, data["url"]) == (200, "/api/docs/01RBC")
    graph.download.assert_not_called()

    response, _ = call(function_app.open_document, "/api/docs/x", user_headers(), name="../../etc/passwd")
    assert response.status_code == 400


def test_a_file_removed_from_sharepoint_since_indexing_is_a_404(monkeypatch):
    search, graph, docs = documents_service(FOUND, GraphError(404, "itemNotFound"))
    monkeypatch.setattr(function_app, "_services", lambda: (search, docs))
    response, _ = call(function_app.open_document, "/api/docs/01RBC", user_headers(), name="01RBC")
    assert response.status_code == 404


def test_citation_previews_follow_the_url_with_the_users_token(monkeypatch):
    search = Mock()
    search.get_citation_document.return_value = {"page_number_from": 12}
    monkeypatch.setattr(function_app, "_services", lambda: (search, None))
    url = "https://srch.search.windows.net/indexes/idx/docs/chunk-1"
    response, data = call(function_app.citation_preview, "/api/citation", user_headers(), {"url": url})
    assert (response.status_code, data) == (200, {"page_number_from": 12})
    search.get_citation_document.assert_called_once_with(url, user_token=USER_TOKEN)

    search.get_citation_document.side_effect = SearchError(404, "Not found")
    response, _ = call(function_app.citation_preview, "/api/citation", user_headers(), {"url": url})
    assert response.status_code == 404


def test_content_disposition_cannot_inject_headers():
    header = content_disposition('evil"\r\nSet-Cookie: x=1.pdf')
    assert "\r" not in header and "\n" not in header
    assert header.startswith('inline; filename="evil___Set-Cookie_ x_1.pdf"')
