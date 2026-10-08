"""Settings and credentials."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

from azure.core.credentials import TokenCredential

from .conversation import DEFAULT_TOKEN_BUDGET


@dataclass(frozen=True)
class Settings:
    search_endpoint: str
    api_version: str
    index_name: str
    indexer_name: str
    knowledge_source: str
    knowledge_base: str
    # The indexer's target: chunks wait here, with no permission filtering, until the sync copies them.
    staging_index_name: str = ""
    staging_blob_endpoint: str = ""
    staging_container: str = "staging"
    state_container: str = "sync-state"
    retrieve_timeout_s: float = 90.0
    conversation_token_budget: int = DEFAULT_TOKEN_BUDGET
    foundry_project_endpoint: str = ""
    agent_name: str = ""
    agent_timeout_s: float = 110.0
    # Files staged per sync run, so one run stays well inside the Function timeout.
    sync_max_files_per_run: int = 25
    # Azure AI Search S1 indexers skip blobs over 128 MB.
    sync_max_file_bytes: int = 128 * 1024 * 1024

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> Settings:
        token_budget = int(env.get("CONVERSATION_TOKEN_BUDGET", DEFAULT_TOKEN_BUDGET))
        if not 0 < token_budget <= DEFAULT_TOKEN_BUDGET:
            raise ValueError(f"CONVERSATION_TOKEN_BUDGET must be between 1 and {DEFAULT_TOKEN_BUDGET}.")
        files_per_run = int(env.get("SYNC_MAX_FILES_PER_RUN", 25))
        if files_per_run < 1:
            raise ValueError("SYNC_MAX_FILES_PER_RUN must be at least 1.")
        return cls(
            search_endpoint=env["SEARCH_ENDPOINT"].rstrip("/"),
            api_version=env.get("SEARCH_API_VERSION", "2026-08-01-preview"),
            index_name=env["SEARCH_INDEX"],
            indexer_name=env["SEARCH_INDEXER"],
            knowledge_source=env["KNOWLEDGE_SOURCE"],
            knowledge_base=env["KNOWLEDGE_BASE"],
            staging_index_name=env.get("SEARCH_STAGING_INDEX", ""),
            staging_blob_endpoint=env.get("STAGING_BLOB_ENDPOINT", "").rstrip("/"),
            staging_container=env.get("STAGING_CONTAINER", "staging"),
            state_container=env.get("SYNC_STATE_CONTAINER", "sync-state"),
            conversation_token_budget=token_budget,
            foundry_project_endpoint=env.get("FOUNDRY_PROJECT_ENDPOINT", "").rstrip("/"),
            agent_name=env.get("AGENT_NAME", ""),
            sync_max_files_per_run=files_per_run,
        )


def get_credential() -> TokenCredential:
    """The app's user-assigned identity in Azure; the az login identity when run locally."""
    from azure.identity import AzureCliCredential, ManagedIdentityCredential

    client_id = os.environ.get("AZURE_CLIENT_ID")
    if client_id:
        return ManagedIdentityCredential(client_id=client_id)
    return AzureCliCredential(process_timeout=30)
