"""Foundry Agent Service client. The prompt agent answers by calling the Foundry IQ knowledge base over MCP.

Foundry turns each knowledge base citation into a url_citation annotation whose URL is the cited chunk's citationUrl,
and every knowledge base call returns its documents with the full source data (pages included). Rewriting each
annotated marker as [ref_id:N] lets the same grounding gate verify agent answers.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any

import requests
from azure.core.credentials import TokenCredential

from .config import Settings
from .conversation import AGENT_TOKEN_BUDGET, select_context

FOUNDRY_SCOPE = "https://ai.azure.com/.default"
# 【message_idx:search_idx†source】, the citation format Foundry annotates for knowledge base tools.
_AGENT_MARKER = re.compile(r"【([^†】\n]{0,40})(?:†[^】\n]{0,300})?】")


class AgentError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"Foundry Agent Service returned HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


@dataclass
class ToolCall:
    query: str | None
    status: str | None
    document_count: int
    error: Any = None


@dataclass
class AgentResult:
    answer_raw: str
    answer: str
    references: list[dict[str, Any]]
    tool_calls: list[ToolCall] = field(default_factory=list)
    response_id: str | None = None
    status: str | None = None
    incomplete_reason: str | None = None
    model: str | None = None
    agent_name: str | None = None
    agent_version: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    reasoning_tokens: int | None = None
    conversation: dict[str, int] | None = None


class AgentService:
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

    @property
    def configured(self) -> bool:
        return bool(self._settings.foundry_project_endpoint and self._settings.agent_name)

    def _headers(self) -> dict[str, str]:
        if self._token is None or self._token[1] - time.time() < 300:
            access = self._credential.get_token(FOUNDRY_SCOPE)
            self._token = (access.token, access.expires_on)
        return {"Authorization": f"Bearer {self._token[0]}", "Content-Type": "application/json"}

    def ask(
        self, question: str, history: list[dict[str, str]] | None = None, user_token: str | None = None
    ) -> AgentResult:
        """One stateless agent run: the conversation travels as input messages and nothing is stored in Foundry.

        The user's search token goes in as a structured input; the agent's MCP tool sends it to the knowledge base
        as x-ms-query-source-authorization, so retrieval returns only what this user may see.
        """
        budget = min(self._settings.conversation_token_budget, AGENT_TOKEN_BUDGET)
        context = select_context(question, history or [], budget)
        body: dict[str, Any] = {
            "agent_reference": {"type": "agent_reference", "name": self._settings.agent_name},
            "input": [{"role": turn["role"], "content": turn["text"]} for turn in context.history]
            + [{"role": "user", "content": question}],
            "store": False,
        }
        if user_token:
            body["structured_inputs"] = {"search_auth_token": user_token}
        # One retry when the connection drops before a response (e.g. a stale pooled connection); runs are read-only.
        for attempt in (1, 2):
            try:
                response = self._session.post(
                    f"{self._settings.foundry_project_endpoint}/openai/v1/responses",
                    json=body,
                    headers=self._headers(),
                    timeout=self._settings.agent_timeout_s,
                )
                break
            except requests.Timeout as exc:
                raise AgentError(504, f"No response within {self._settings.agent_timeout_s:.0f} s.") from exc
            except requests.ConnectionError as exc:
                if attempt == 2:
                    raise AgentError(502, str(exc)) from exc
            except requests.RequestException as exc:
                raise AgentError(502, str(exc)) from exc
        if response.status_code != 200:
            raise AgentError(response.status_code, response.text[:2000])
        result = parse_response(response.json())
        result.conversation = context.diagnostics()
        return result


def parse_response(data: dict[str, Any]) -> AgentResult:
    """Collects the tool calls and their documents, then rewrites the final answer's citations as [ref_id:N]."""
    references: list[dict[str, Any]] = []
    ids_by_url: dict[str, str] = {}
    tool_calls: list[ToolCall] = []
    messages: list[dict[str, Any]] = []
    for item in data.get("output") or []:
        if item.get("type") == "mcp_call":
            documents = _documents(item.get("output"))
            for index, document in enumerate(documents, start=1):
                url = document.get("url")
                if not url or url in ids_by_url:
                    continue
                ref_id = f"{len(tool_calls) + 1}.{index}"
                ids_by_url[url] = ref_id
                source = _json_object(document.get("content"))
                references.append(
                    {
                        "type": "searchIndex",
                        "id": ref_id,
                        "docKey": source.get("chunk_id"),
                        "citationUrl": url,
                        "sourceData": source,
                    }
                )
            tool_calls.append(
                ToolCall(
                    query=_query(item.get("arguments")),
                    status=item.get("status"),
                    document_count=len(documents),
                    error=item.get("error"),
                )
            )
        elif item.get("type") == "message" and item.get("role", "assistant") == "assistant":
            messages.append(item)

    # Reasoning models can emit commentary before their final answer; only the answer is shown.
    final = [message for message in messages if message.get("phase") in (None, "final_answer")] or messages[-1:]
    raw_parts: list[str] = []
    gated_parts: list[str] = []
    for message in final:
        for part in message.get("content") or []:
            if part.get("type") != "output_text" or not part.get("text"):
                continue
            raw_parts.append(part["text"])
            gated_parts.append(_rewrite_markers(part["text"], part.get("annotations") or [], ids_by_url))

    usage = data.get("usage") or {}
    agent = data.get("agent_reference") or {}
    return AgentResult(
        answer_raw="\n\n".join(raw_parts),
        answer="\n\n".join(gated_parts),
        references=references,
        tool_calls=tool_calls,
        response_id=data.get("id"),
        status=data.get("status"),
        incomplete_reason=(data.get("incomplete_details") or {}).get("reason"),
        model=data.get("model"),
        agent_name=agent.get("name"),
        agent_version=agent.get("version"),
        input_tokens=usage.get("input_tokens"),
        output_tokens=usage.get("output_tokens"),
        reasoning_tokens=(usage.get("output_tokens_details") or {}).get("reasoning_tokens"),
    )


def _rewrite_markers(text: str, annotations: list[dict[str, Any]], ids_by_url: dict[str, str]) -> str:
    """Annotated markers become [ref_id:N]; any other marker keeps its own index so the gate strips and reports it."""
    urls_by_span: dict[tuple[int, int], str] = {}
    for annotation in annotations:
        if annotation.get("type") == "url_citation" and annotation.get("url"):
            span = _marker_span(text, annotation.get("start_index"), annotation.get("end_index"))
            if span:
                urls_by_span[span] = annotation["url"]

    def replace(match: re.Match[str]) -> str:
        ref_id = ids_by_url.get(urls_by_span.get(match.span(), ""))
        return f"[ref_id:{ref_id or match.group(1).strip() or 'unmatched'}]"

    return _AGENT_MARKER.sub(replace, text)


def _marker_span(text: str, start: Any, end: Any) -> tuple[int, int] | None:
    if not isinstance(start, int) or not isinstance(end, int):
        return None
    # Offsets are code points in practice; UTF-16 offsets are accepted too in case text has astral characters.
    for low, high in ((start, end), (_utf16_to_index(text, start), _utf16_to_index(text, end))):
        if 0 <= low < high <= len(text) and _AGENT_MARKER.fullmatch(text, low, high):
            return low, high
    return None


def _utf16_to_index(text: str, offset: int) -> int:
    units = 0
    for index, char in enumerate(text):
        if units >= offset:
            return index
        units += 2 if ord(char) > 0xFFFF else 1
    return len(text)


def _documents(output: Any) -> list[dict[str, Any]]:
    documents = _json_object(output).get("documents")
    return [document for document in documents if isinstance(document, dict)] if isinstance(documents, list) else []


def _query(arguments: Any) -> str | None:
    variants = _json_object(arguments).get("query_variants")
    if isinstance(variants, list):
        return " | ".join(str(variant) for variant in variants) or None
    return None


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}
