"""HTTP API and the SharePoint sync for the citation-grounded RAG POC. The React app in web/ is the UI.

Every HTTP call carries the signed-in user's Azure AI Search token (rag/auth.py), and every search runs with it, so
answers, citations, the library and PDFs only ever come from documents that user may see.
"""

from __future__ import annotations

import json
import logging
import time
from functools import lru_cache
from typing import Any
from urllib.parse import quote

import azure.functions as func
from azure.core.credentials import TokenCredential

from rag.agent import AgentError, AgentResult, AgentService
from rag.auth import UserTokenError, user_token
from rag.config import Settings, get_credential
from rag.conversation import MAX_REQUEST_BYTES, ContextBudgetError
from rag.docs import LINK_TTL, DocumentService, content_disposition
from rag.grounding import apply_gate
from rag.search import SearchError, SearchService
from rag.sharepoint import GraphClient, GraphError
from rag.staging import StagingStore
from rag.sync import SharePointSync
from rag.telemetry import emit, summarize_activity

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)

MAX_QUESTION_CHARS = 2000
# direct: the Function calls the knowledge base retrieve action. agent: the Foundry agent answers with its KB tool.
ASK_MODES = ("direct", "agent")


@lru_cache(maxsize=1)
def _settings() -> Settings:
    return Settings.from_env()


@lru_cache(maxsize=1)
def _credential() -> TokenCredential:
    return get_credential()


@lru_cache(maxsize=1)
def _graph() -> GraphClient:
    return GraphClient(_credential())


@lru_cache(maxsize=1)
def _services() -> tuple[SearchService, DocumentService]:
    search = SearchService(_settings(), _credential())
    return search, DocumentService(search, _graph(), _settings().sync_max_file_bytes)


@lru_cache(maxsize=1)
def _agent_service() -> AgentService:
    return AgentService(_settings(), _credential())


def _json(payload: Any, status: int = 200, headers: dict[str, str] | None = None) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(payload, ensure_ascii=False), status_code=status, mimetype="application/json", headers=headers
    )


def _unauthorized(code: str, message: str) -> func.HttpResponse:
    return _json({"error": message, "code": code}, 401, headers={"WWW-Authenticate": "Bearer", "Cache-Control": "no-store"})


def _search_failure(exc: SearchError, message: str) -> func.HttpResponse:
    if exc.status == 401:
        # Search validates the user token itself; an expired or forged token ends up here.
        return _unauthorized("invalid_token", "Azure AI Search rejected your sign-in. Refresh the page to sign in again.")
    return _json({"error": message, "status": exc.status}, 502)


def _parse_ask(req: func.HttpRequest) -> tuple[str, list[dict[str, str]], str]:
    try:
        body = req.get_json()
    except ValueError as exc:
        raise ValueError('Send a JSON body like {"question": "..."}.') from exc
    if not isinstance(body, dict):
        raise ValueError('Send a JSON body like {"question": "..."}.')
    raw_question = body.get("question")
    if not isinstance(raw_question, str):
        raise ValueError("question must be a string.")
    question = raw_question.strip()
    if not question:
        raise ValueError("question is required.")
    if len(question) > MAX_QUESTION_CHARS:
        raise ValueError(f"question is longer than {MAX_QUESTION_CHARS} characters.")
    raw_history = body.get("history")
    if raw_history is None:
        raw_history = []
    if not isinstance(raw_history, list):
        raise ValueError("history must be an array of user and assistant messages.")
    history: list[dict[str, str]] = []
    for index, message in enumerate(raw_history):
        if (
            not isinstance(message, dict)
            or message.get("role") not in ("user", "assistant")
            or not isinstance(message.get("text"), str)
            or not message["text"].strip()
        ):
            raise ValueError(f"history[{index}] must have a user or assistant role and nonempty text.")
        history.append({"role": message["role"], "text": message["text"]})
    if history and history[0]["role"] != "user":
        raise ValueError("history must start with a user message.")
    mode = body.get("mode", "direct")
    if mode not in ASK_MODES:
        raise ValueError(f"mode must be one of: {', '.join(ASK_MODES)}.")
    return question, history, mode


@app.route(route="ask", methods=["POST"])
def ask(req: func.HttpRequest) -> func.HttpResponse:
    """Retrieve -> grounding gate -> citations -> telemetry. The agent mode swaps the retrieve step for a
    Foundry agent run and gates the agent's citations the same way. Both run with the user's search token."""
    if len(req.get_body()) > MAX_REQUEST_BYTES:
        return _json({"error": "The conversation request exceeds the 16 MiB transport limit."}, 413)
    try:
        token = user_token(req.headers)
    except UserTokenError as exc:
        return _unauthorized(exc.code, str(exc))
    try:
        question, history, mode = _parse_ask(req)
    except ValueError as exc:
        return _json({"error": str(exc)}, 400)
    if mode == "agent":
        return _ask_agent(question, history, token)

    search, _ = _services()
    started = time.perf_counter()
    try:
        result = search.retrieve(question, history, user_token=token)
    except ContextBudgetError as exc:
        logging.warning("Conversation context rejected: %s", exc)
        return _json({"error": str(exc)}, 400)
    except SearchError as exc:
        logging.error("Knowledge base retrieve failed: %s", exc)
        return _search_failure(exc, "Knowledge base retrieval failed.")

    answer_raw = "\n".join(
        part.get("text", "")
        for message in result.get("response") or []
        for part in message.get("content") or []
        if part.get("type") == "text"
    )
    activity = summarize_activity(result.get("activity"))
    warnings = []
    if result.get("_httpStatus") == 206:
        warnings.append("Partial retrieval: at least one source failed (see diagnostics.activity).")
    return _gated_response(
        mode="direct",
        question=question,
        history=history,
        started=started,
        answer_raw=answer_raw,
        gate_input=answer_raw,
        references=result.get("references") or [],
        conversation=result.get("_conversation"),
        status=result.get("_httpStatus"),
        stages=activity["stages"],
        tokens=(activity["input_tokens"], activity["output_tokens"], activity["reasoning_tokens"]),
        warnings=warnings,
    )


def _ask_agent(question: str, history: list[dict[str, str]], token: str) -> func.HttpResponse:
    agent = _agent_service()
    if not agent.configured:
        return _json({"error": "Foundry Agent mode isn't configured on this API (FOUNDRY_PROJECT_ENDPOINT, AGENT_NAME)."}, 503)
    started = time.perf_counter()
    try:
        result = agent.ask(question, history, user_token=token)
    except ContextBudgetError as exc:
        logging.warning("Conversation context rejected: %s", exc)
        return _json({"error": str(exc)}, 400)
    except AgentError as exc:
        logging.error("Foundry agent run failed: %s", exc)
        status = 504 if exc.status == 504 else 502
        return _json({"error": "The Foundry agent run failed.", "status": exc.status}, status)

    failed_calls = [call for call in result.tool_calls if call.error or call.status not in (None, "completed")]
    warnings = []
    if not result.tool_calls:
        warnings.append("The agent answered without searching the reports.")
    if failed_calls:
        warnings.append("Partial retrieval: at least one knowledge base call failed (see diagnostics.activity).")
    if result.status != "completed":
        warnings.append(
            f"The agent run ended with status {result.status or 'unknown'}"
            + (f" ({result.incomplete_reason})" if result.incomplete_reason else "")
            + "; the answer may be incomplete."
        )
    return _gated_response(
        mode="agent",
        question=question,
        history=history,
        started=started,
        answer_raw=result.answer_raw,
        gate_input=result.answer,
        references=result.references,
        conversation=result.conversation,
        # 206 mirrors the knowledge base's partial-retrieval status, so clients treat both modes alike.
        status=206 if failed_calls else 200,
        stages=[
            {"type": "knowledgeBaseCall", "query": call.query, "count": call.document_count, "status": call.status,
             **({"error": call.error} if call.error else {})}
            for call in result.tool_calls
        ],
        tokens=(result.input_tokens, result.output_tokens, result.reasoning_tokens),
        warnings=warnings,
        extra={"agent": _agent_summary(result)},
    )


def _agent_summary(result: AgentResult) -> dict[str, Any]:
    return {
        "name": result.agent_name,
        "version": result.agent_version,
        "model": result.model,
        "response_id": result.response_id,
        "status": result.status,
        "tool_calls": len(result.tool_calls),
    }


def _gated_response(
    *,
    mode: str,
    question: str,
    history: list[dict[str, str]],
    started: float,
    answer_raw: str,
    gate_input: str,
    references: list[dict[str, Any]],
    conversation: dict[str, int] | None,
    status: int | None,
    stages: list[dict[str, Any]],
    tokens: tuple[int | None, int | None, int | None],
    warnings: list[str],
    extra: dict[str, Any] | None = None,
) -> func.HttpResponse:
    """Grounding gate, diagnostics and telemetry, shared by both modes."""
    gate = apply_gate(gate_input, references)
    all_warnings = list(gate.warnings)
    if conversation and conversation["history_messages_omitted"]:
        omitted = conversation["history_messages_omitted"]
        all_warnings.append(
            f"Conversation context: {omitted} earlier {'message was' if omitted == 1 else 'messages were'} left out "
            "of this answer to stay within the context limit. They remain in your chat; restate older details if needed."
        )
    all_warnings.extend(warnings)

    diagnostics = {
        "mode": mode,
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
        "retrieve_status": status,
        "gate_passed": gate.passed,
        "reference_count": len(references),
        "citation_count": len(gate.citations),
        "uncited_reference_count": gate.uncited_reference_count,
        "unresolved_ref_ids": gate.unresolved_ref_ids,
        "incomplete_ref_ids": gate.incomplete_ref_ids,
        "grounded_sentence_ratio": gate.grounded_sentence_ratio,
        "sentences_total": gate.sentences_total,
        "sentences_grounded": gate.sentences_grounded,
        "input_tokens": tokens[0],
        "output_tokens": tokens[1],
        "reasoning_tokens": tokens[2],
        "conversation": conversation,
        **(extra or {}),
    }
    emit(
        "ask_telemetry",
        {
            **diagnostics,
            "question_chars": len(question),
            "history_turns": len(history),
            "stages": [{k: s.get(k) for k in ("type", "elapsed_ms", "count")} for s in stages],
        },
    )
    return _json(
        {
            "mode": mode,
            "answer": gate.answer,
            "citations": gate.citations,
            "warnings": all_warnings,
            "diagnostics": {**diagnostics, "answer_raw": answer_raw, "activity": stages},
        }
    )


@app.route(route="documents", methods=["GET"])
def list_documents(req: func.HttpRequest) -> func.HttpResponse:
    """The documents this user can see, with their citation metadata and how many chunks each has in the index."""
    try:
        token = user_token(req.headers)
    except UserTokenError as exc:
        return _unauthorized(exc.code, str(exc))
    search, _ = _services()
    try:
        rows = search.list_documents(token)
    except SearchError as exc:
        logging.error("Document list lookup failed: %s", exc)
        return _search_failure(exc, "Search lookup failed.")
    documents = [
        {
            # The library opens documents by this ID, through /api/docs.
            "file": row["document_id"],
            "title": row.get("doc_title") or row.get("source_file") or row["document_id"],
            "institution": row.get("institution"),
            "fiscal_year": row.get("fiscal_year"),
            "size_bytes": None,
            "last_modified": row.get("last_modified"),
            "chunks": row.get("chunks", 0),
        }
        for row in rows
        if row.get("document_id")
    ]
    documents.sort(key=lambda doc: ((doc["institution"] or doc["title"]).lower(), doc["title"].lower()))
    return _json({"documents": documents}, headers={"Cache-Control": "no-store"})


@app.route(route="docs/{name}", methods=["GET"])
def open_document(req: func.HttpRequest) -> func.HttpResponse:
    """Streams a PDF from SharePoint once a lookup with the user's token shows they can see the document.

    With ?format=json it returns the URL to load instead, so a viewer can reuse it while switching pages.
    """
    try:
        token = user_token(req.headers)
    except UserTokenError as exc:
        return _unauthorized(exc.code, str(exc))
    _, documents = _services()
    try:
        document = documents.find(req.route_params.get("name", ""), token)
    except ValueError as exc:
        return _json({"error": str(exc)}, 400)
    except SearchError as exc:
        return _search_failure(exc, "Document lookup failed.")
    if document is None:
        return _json({"error": "Document not found."}, 404)
    if req.params.get("format") == "json":
        return _json(
            {"url": f"/api/docs/{quote(document['document_id'], safe='')}", "expires_in": int(LINK_TTL.total_seconds())},
            headers={"Cache-Control": "no-store"},
        )
    try:
        content = documents.content(document)
    except GraphError as exc:
        logging.error("Reading %s from SharePoint failed: %s", document["document_id"], exc)
        if exc.status == 404:
            return _json({"error": "The document is no longer in SharePoint."}, 404)
        return _json({"error": "Could not read the document from SharePoint.", "status": exc.status}, 502)
    return func.HttpResponse(
        content,
        status_code=200,
        mimetype="application/pdf",
        headers={
            "Content-Disposition": content_disposition(document.get("source_file") or "document.pdf"),
            "Cache-Control": "private, no-store",
        },
    )


@app.route(route="citation", methods=["GET"])
def citation_preview(req: func.HttpRequest) -> func.HttpResponse:
    """Follows a reference's citationUrl with the user's token and returns the indexed chunk."""
    try:
        token = user_token(req.headers)
    except UserTokenError as exc:
        return _unauthorized(exc.code, str(exc))
    search, _ = _services()
    try:
        return _json(search.get_citation_document(req.params.get("url", ""), user_token=token))
    except ValueError as exc:
        return _json({"error": str(exc)}, 400)
    except SearchError as exc:
        if exc.status == 404:
            return _json({"error": "Passage not found."}, 404)
        return _search_failure(exc, "Citation lookup failed.")


@app.timer_trigger(schedule="0 */5 * * * *", arg_name="timer", run_on_startup=False, use_monitor=True)
def sharepoint_sync(timer: func.TimerRequest) -> None:
    """SharePoint changes -> staging -> indexer -> staging index -> published with group IDs."""
    settings = _settings()
    if not settings.staging_blob_endpoint:
        logging.warning("STAGING_BLOB_ENDPOINT isn't set; the SharePoint sync is off.")
        return
    started = time.perf_counter()
    search, _ = _services()
    summary = SharePointSync(settings, _graph(), StagingStore(settings, _credential()), search).run()
    emit("sharepoint_sync", {**summary, "elapsed_ms": round((time.perf_counter() - started) * 1000)})
