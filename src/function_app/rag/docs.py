"""PDFs for the source viewer, streamed from SharePoint after a permission-filtered lookup.

The user's own search token decides whether they may open a document: if none of its chunks is visible to them, the
API answers 404, as if it didn't exist. The file is then read with the app's identity (Sites.Selected), so users need
no SharePoint access of their own, and nothing is stored on the way.
"""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any
from urllib.parse import quote

from .search import SearchService
from .sharepoint import GraphClient

# How long the UI may reuse a document URL before asking again (web/src/hooks/useDocumentUrl.ts).
LINK_TTL = timedelta(minutes=15)
# Graph drive item IDs: letters, digits and a few separators.
_DOCUMENT_ID = re.compile(r"^[A-Za-z0-9!_\-.]{1,256}$")


def content_disposition(file_name: str) -> str:
    ascii_name = re.sub(r'[^A-Za-z0-9 ._()-]', "_", file_name) or "document.pdf"
    return f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(file_name, safe='')}"


class DocumentService:
    def __init__(self, search: SearchService, graph: GraphClient, max_bytes: int) -> None:
        self._search = search
        self._graph = graph
        self._max_bytes = max_bytes

    def find(self, document_id: str, user_token: str) -> dict[str, Any] | None:
        if not _DOCUMENT_ID.match(document_id or ""):
            raise ValueError("Invalid document ID.")
        return self._search.find_document(document_id, user_token)

    def content(self, document: dict[str, Any]) -> bytes:
        return self._graph.download(document["drive_id"], document["document_id"], self._max_bytes)
