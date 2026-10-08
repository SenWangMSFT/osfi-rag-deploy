"""Minimal REST client for the Azure AI Search operations the app uses.

The chunk index filters documents by their permission fields (GroupIds, UserIds). Calls made for a signed-in user carry
the user's own token in x-ms-query-source-authorization, so Search returns only what that user may see. An app-only
token (the managed identity) sees none of those chunks, and Search refuses it an elevated read. So the sync job never
queries the chunk index: the indexer writes to a staging index without permission filtering, and the job copies each
document's chunks into the chunk index under keys it derives, which it later uses to update or delete them.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import unquote, urlsplit

import requests
from azure.core.credentials import TokenCredential

from .config import Settings
from .conversation import select_context

SEARCH_SCOPE = "https://search.azure.com/.default"
KEY_FIELD = "chunk_id"
USER_TOKEN_HEADER = "x-ms-query-source-authorization"
DOCUMENT_FIELDS = "document_id,drive_id,doc_title,institution,fiscal_year,source_file,last_modified"
PAGE_SIZE = 1000
# Chunks with their 3072-dimension vectors run to tens of KB each in JSON; this keeps requests to a few MB.
VECTOR_PAGE_SIZE = 100


class SearchError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"Azure AI Search returned HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


def odata_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class SearchService:
    def __init__(
        self,
        settings: Settings,
        credential: TokenCredential,
        session: requests.Session | None = None,
    ) -> None:
        self._settings = settings
        self._credential = credential
        self._session = session or requests.Session()
        self._token: tuple[str, float] | None = None

    def _headers(self, user_token: str | None = None) -> dict[str, str]:
        if self._token is None or self._token[1] - time.time() < 300:
            access = self._credential.get_token(SEARCH_SCOPE)
            self._token = (access.token, access.expires_on)
        headers = {"Authorization": f"Bearer {self._token[0]}", "Content-Type": "application/json"}
        if user_token:
            # The bare token: "Bearer <token>" is rejected with 401.
            headers[USER_TOKEN_HEADER] = user_token
        return headers

    def _url(self, path: str) -> str:
        return f"{self._settings.search_endpoint}/{path}?api-version={self._settings.api_version}"

    def _post(
        self,
        path: str,
        body: dict[str, Any] | None,
        ok: tuple[int, ...] = (200,),
        user_token: str | None = None,
    ) -> requests.Response:
        response = self._session.post(
            self._url(path),
            json=body,
            headers=self._headers(user_token),
            timeout=self._settings.retrieve_timeout_s,
        )
        if response.status_code not in ok:
            raise SearchError(response.status_code, response.text[:2000])
        return response

    def _search(self, body: dict[str, Any], user_token: str | None = None, index: str | None = None) -> dict[str, Any]:
        return self._post(
            f"indexes/{index or self._settings.index_name}/docs/search", body, user_token=user_token
        ).json()

    def _index(self, actions: list[dict[str, Any]], index: str | None = None) -> list[dict[str, Any]]:
        path = f"indexes/{index or self._settings.index_name}/docs/index"
        return self._post(path, {"value": actions}, ok=(200, 207)).json().get("value", [])

    def retrieve(
        self, question: str, history: list[dict[str, str]] | None = None, user_token: str | None = None
    ) -> dict[str, Any]:
        """Agentic retrieval with answer synthesis. A 206 (partial) result is returned, not raised."""
        context = select_context(question, history or [], self._settings.conversation_token_budget)
        messages = [
            {"role": turn["role"], "content": [{"type": "text", "text": turn["text"]}]} for turn in context.history
        ]
        messages.append({"role": "user", "content": [{"type": "text", "text": question}]})
        body = {
            "messages": messages,
            "includeActivity": True,
            "knowledgeSourceParams": [
                {
                    "knowledgeSourceName": self._settings.knowledge_source,
                    "kind": "searchIndex",
                    "includeReferences": True,
                    # Without this, references[].sourceData is null and no page number reaches the answer.
                    "includeReferenceSourceData": True,
                }
            ],
        }
        response = self._post(
            f"knowledgebases/{self._settings.knowledge_base}/retrieve", body, ok=(200, 206), user_token=user_token
        )
        result = response.json()
        result["_httpStatus"] = response.status_code
        result["_conversation"] = context.diagnostics()
        return result

    def get_citation_document(self, citation_url: str, user_token: str | None = None) -> dict[str, Any]:
        """Follows a citationUrl verbatim, but only when it points at this service's chunk index.

        With a user token, the chunk must also be visible to that user in a permission-filtered search, so a
        citationUrl copied from someone else's answer reveals nothing.
        """
        target = urlsplit(citation_url)
        service = urlsplit(self._settings.search_endpoint)
        prefix = f"/indexes/{self._settings.index_name}/docs/"
        if (
            target.scheme != "https"
            or target.netloc.lower() != service.netloc.lower()
            or not target.path.startswith(prefix)
        ):
            raise ValueError("citationUrl does not point at the configured index.")
        response = self._session.get(citation_url, headers=self._headers(user_token), timeout=30)
        if response.status_code != 200:
            raise SearchError(response.status_code, response.text[:2000])
        key = unquote(target.path[len(prefix) :])
        if user_token and not self._search(
            {"search": "*", "filter": f"{KEY_FIELD} eq {odata_literal(key)}", "select": KEY_FIELD, "top": 1},
            user_token=user_token,
        ).get("value"):
            raise SearchError(404, "The passage isn't visible to this user.")
        return response.json()

    def find_document(self, document_id: str, user_token: str) -> dict[str, Any] | None:
        """The document's fields if this user can see at least one of its chunks; None otherwise."""
        body = {
            "search": "*",
            "filter": f"document_id eq {odata_literal(document_id)}",
            "select": DOCUMENT_FIELDS,
            "top": 1,
        }
        values = self._search(body, user_token=user_token).get("value") or []
        return values[0] if values else None

    def list_documents(self, user_token: str) -> list[dict[str, Any]]:
        """One row per document this user can see, with its chunk count. ordinal_position 0 is each document's first chunk."""
        counts = self.facet_counts("document_id", user_token=user_token)
        documents: list[dict[str, Any]] = []
        while True:
            body = {
                "search": "*",
                "filter": "ordinal_position eq 0",
                "select": DOCUMENT_FIELDS,
                "top": PAGE_SIZE,
                "skip": len(documents),
            }
            batch = self._search(body, user_token=user_token).get("value") or []
            documents.extend(batch)
            if len(batch) < PAGE_SIZE:
                break
        for document in documents:
            document["chunks"] = counts.get(document.get("document_id"), 0)
        return documents

    def facet_counts(self, field: str, limit: int = PAGE_SIZE, user_token: str | None = None) -> dict[str, int]:
        body = {"search": "*", "top": 0, "facets": [f"{field},count:{limit}"]}
        data = self._search(body, user_token=user_token)
        return {facet["value"]: facet["count"] for facet in data.get("@search.facets", {}).get(field, [])}

    # The sync job's calls. It reads the staging index, and writes to the chunk index by key only.

    def staged_documents(self, limit: int = PAGE_SIZE) -> dict[str, int]:
        """Chunk counts per document_id in the staging index."""
        body = {"search": "*", "top": 0, "facets": [f"document_id,count:{limit}"]}
        data = self._search(body, index=self._settings.staging_index_name)
        return {facet["value"]: facet["count"] for facet in data.get("@search.facets", {}).get("document_id", [])}

    def staged_chunks(self, document_id: str) -> list[dict[str, Any]]:
        """Every staging-index chunk of a document, with all its fields, vectors included."""
        rows: list[dict[str, Any]] = []
        while True:
            body = {
                "search": "*",
                "filter": f"document_id eq {odata_literal(document_id)}",
                "orderby": KEY_FIELD,
                "top": VECTOR_PAGE_SIZE,
                "skip": len(rows),
            }
            batch = self._search(body, index=self._settings.staging_index_name).get("value") or []
            rows.extend({name: value for name, value in row.items() if not name.startswith("@")} for row in batch)
            if len(batch) < VECTOR_PAGE_SIZE:
                return rows

    def delete_staged(self, keys: list[str]) -> int:
        for start in range(0, len(keys), PAGE_SIZE):
            actions = [{"@search.action": "delete", KEY_FIELD: key} for key in keys[start : start + PAGE_SIZE]]
            self._index(actions, index=self._settings.staging_index_name)
        return len(keys)

    def upload_documents(self, documents: list[dict[str, Any]]) -> int:
        """Writes whole chunks to the chunk index, replacing any with the same key."""
        for start in range(0, len(documents), VECTOR_PAGE_SIZE):
            actions = [{"@search.action": "upload", **doc} for doc in documents[start : start + VECTOR_PAGE_SIZE]]
            failed = [item for item in self._index(actions) if not item.get("status")]
            if failed:
                raise SearchError(207, f"{len(failed)} uploads failed, e.g. {failed[0]}")
        return len(documents)

    def merge_documents(self, documents: list[dict[str, Any]]) -> int:
        """Partial updates by key; only the fields given change. Chunks that disappeared meanwhile are skipped."""
        merged = 0
        for start in range(0, len(documents), PAGE_SIZE):
            actions = [{"@search.action": "merge", **doc} for doc in documents[start : start + PAGE_SIZE]]
            results = self._index(actions)
            failed = [item for item in results if not item.get("status") and item.get("statusCode") != 404]
            if failed:
                raise SearchError(207, f"{len(failed)} merges failed, e.g. {failed[0]}")
            merged += sum(1 for item in results if item.get("status"))
        return merged

    def delete_documents(self, keys: list[str]) -> int:
        """Deletes chunks from the chunk index by key; keys that don't exist are fine."""
        for start in range(0, len(keys), PAGE_SIZE):
            self._index([{"@search.action": "delete", KEY_FIELD: key} for key in keys[start : start + PAGE_SIZE]])
        return len(keys)

    def run_indexer(self) -> int:
        """Starts an indexer run. 409 means a run is already in progress, which is fine."""
        return self._post(f"indexers/{self._settings.indexer_name}/run", None, ok=(202, 409)).status_code

    def indexer_status(self) -> dict[str, Any]:
        response = self._session.get(
            self._url(f"indexers/{self._settings.indexer_name}/status"), headers=self._headers(), timeout=30
        )
        if response.status_code != 200:
            raise SearchError(response.status_code, response.text[:2000])
        return response.json()
