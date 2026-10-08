"""The short-lived staging container and the sync job's state, both in the staging storage account.

A file stays in the staging container only until the indexer has turned it into chunks; the sync job then deletes it.
Blob soft delete and versioning are off on this account (infra/modules/staging.bicep), so a deleted file is gone.
"""

from __future__ import annotations

import json
from typing import Any

from azure.core.credentials import TokenCredential
from azure.core.exceptions import ResourceNotFoundError
from azure.storage.blob import BlobServiceClient, ContentSettings

from .config import Settings

REGISTRY_BLOB = "registry.json"


class StagingStore:
    def __init__(
        self, settings: Settings, credential: TokenCredential, service: BlobServiceClient | None = None
    ) -> None:
        if service is None:
            if not settings.staging_blob_endpoint:
                raise ValueError("STAGING_BLOB_ENDPOINT is not set.")
            service = BlobServiceClient(settings.staging_blob_endpoint, credential=credential)
        self._staging = service.get_container_client(settings.staging_container)
        self._state = service.get_container_client(settings.state_container)

    @staticmethod
    def blob_name(drive_id: str, item_id: str) -> str:
        # Fixed per SharePoint item, so an edited file re-indexes the same document instead of adding another.
        return f"{drive_id}/{item_id}.pdf"

    def stage(self, drive_id: str, item_id: str, data: bytes, metadata: dict[str, str]) -> None:
        """Blob metadata must be ASCII, so only IDs travel this way; publishing adds the display fields."""
        self._staging.upload_blob(
            self.blob_name(drive_id, item_id),
            data,
            overwrite=True,
            metadata=metadata,
            content_settings=ContentSettings(content_type="application/pdf"),
        )

    def unstage(self, drive_id: str, item_id: str) -> None:
        try:
            self._staging.delete_blob(self.blob_name(drive_id, item_id))
        except ResourceNotFoundError:
            pass

    def staged_names(self) -> list[str]:
        return [blob.name for blob in self._staging.list_blobs()]

    def read_json(self, name: str, default: Any = None) -> Any:
        try:
            return json.loads(self._state.download_blob(name).readall())
        except ResourceNotFoundError:
            return default

    def write_json(self, name: str, value: Any) -> None:
        self._state.upload_blob(
            name,
            json.dumps(value, indent=1, sort_keys=True).encode("utf-8"),
            overwrite=True,
            content_settings=ContentSettings(content_type="application/json"),
        )

    def delete_json(self, name: str) -> None:
        try:
            self._state.delete_blob(name)
        except ResourceNotFoundError:
            pass
