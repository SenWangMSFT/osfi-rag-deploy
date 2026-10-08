"""Microsoft Graph client for the SharePoint document libraries the sync reads.

The Function App calls Graph app-only as its managed identity, which holds Sites.Selected with read on each registered
site (scripts/grant_sharepoint_access.ps1). Changes come from delta queries, one per document library.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit

import requests
from azure.core.credentials import TokenCredential

GRAPH = "https://graph.microsoft.com/v1.0"
GRAPH_SCOPE = "https://graph.microsoft.com/.default"
# Delta never returns cTag for SharePoint, so eTag is the version.
DELTA_SELECT = "id,name,file,folder,deleted,size,webUrl,eTag,lastModifiedDateTime,parentReference"
MAX_RETRY_AFTER_S = 60.0


class GraphError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"Microsoft Graph returned HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


class DeltaExpired(GraphError):
    """410: the delta link is too old, so the library has to be listed again from the start."""


@dataclass
class DeltaPage:
    items: list[dict[str, Any]]
    next_link: str | None
    delta_link: str | None


class GraphClient:
    def __init__(
        self,
        credential: TokenCredential,
        session: requests.Session | None = None,
        retries: int = 4,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._credential = credential
        self._session = session or requests.Session()
        self._retries = retries
        self._sleep = sleep
        self._token: tuple[str, float] | None = None

    def _headers(self) -> dict[str, str]:
        if self._token is None or self._token[1] - time.time() < 300:
            access = self._credential.get_token(GRAPH_SCOPE)
            self._token = (access.token, access.expires_on)
        return {"Authorization": f"Bearer {self._token[0]}"}

    def _get(self, url: str, stream: bool = False) -> requests.Response:
        attempt = 0
        while True:
            response = self._session.get(url, headers=self._headers(), timeout=120, stream=stream)
            if response.status_code in (429, 503, 504) and attempt < self._retries:
                retry_after = response.headers.get("Retry-After")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else 2.0**attempt
                response.close()
                self._sleep(min(MAX_RETRY_AFTER_S, delay))
                attempt += 1
                continue
            if response.status_code == 410:
                raise DeltaExpired(410, response.text[:500])
            if response.status_code != 200:
                raise GraphError(response.status_code, response.text[:2000])
            return response

    def _json(self, url: str) -> dict[str, Any]:
        return self._get(url).json()

    def site(self, site_id: str = "", site_url: str = "") -> dict[str, Any]:
        """A site by ID, or by URL (https://tenant.sharepoint.com/sites/name)."""
        if site_id:
            return self._json(f"{GRAPH}/sites/{site_id}?$select=id,webUrl,displayName")
        parts = urlsplit(site_url)
        if parts.scheme != "https" or not parts.hostname:
            raise ValueError(f"Not a SharePoint site URL: {site_url!r}")
        path = quote(parts.path.rstrip("/"))
        return self._json(f"{GRAPH}/sites/{parts.hostname}:{path}?$select=id,webUrl,displayName")

    def drives(self, site_id: str) -> list[dict[str, Any]]:
        data = self._json(f"{GRAPH}/sites/{site_id}/drives?$select=id,name,driveType,webUrl")
        return [drive for drive in data.get("value", []) if drive.get("driveType") == "documentLibrary"]

    @staticmethod
    def delta_url(drive_id: str) -> str:
        return f"{GRAPH}/drives/{drive_id}/root/delta?$select={DELTA_SELECT}"

    def delta_page(self, url: str) -> DeltaPage:
        data = self._json(url)
        return DeltaPage(data.get("value") or [], data.get("@odata.nextLink"), data.get("@odata.deltaLink"))

    def item_title(self, drive_id: str, item_id: str) -> str | None:
        """The SharePoint Title column, which people often leave empty."""
        data = self._json(
            f"{GRAPH}/drives/{drive_id}/items/{item_id}?$select=id&$expand=listItem($select=id;$expand=fields($select=Title))"
        )
        title = ((data.get("listItem") or {}).get("fields") or {}).get("Title")
        return title.strip() if isinstance(title, str) and title.strip() else None

    def download(self, drive_id: str, item_id: str, max_bytes: int) -> bytes:
        """The file's content. Graph redirects to a pre-authenticated URL; requests drops our token on that hop."""
        response = self._get(f"{GRAPH}/drives/{drive_id}/items/{item_id}/content", stream=True)
        chunks: list[bytes] = []
        size = 0
        try:
            for chunk in response.iter_content(1 << 20):
                size += len(chunk)
                if size > max_bytes:
                    raise GraphError(413, f"The file is larger than {max_bytes // (1 << 20)} MB.")
                chunks.append(chunk)
        finally:
            response.close()
        return b"".join(chunks)
