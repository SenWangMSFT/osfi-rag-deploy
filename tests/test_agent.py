import json
from unittest.mock import Mock

import azure.functions as func
import requests

import function_app
from helpers import USER_TOKEN, user_headers
from rag.agent import AgentError, AgentResult, AgentService, ToolCall, parse_response
from rag.config import Settings

SEARCH = "https://srch.search.windows.net/indexes/idx/docs"


def document(key, page, title="Royal Bank of Canada Annual Report 2025", file="RBC Annual Report 2025.pdf"):
    source = {
        "chunk_id": key,
        "doc_title": title,
        "institution": title.split()[0],
        "page_number_from": page,
        "page_number_to": page,
        "source_file": file,
        "document_id": f"01{file.split()[0].upper()}2025",
        "chunk_text": "CET1 ratio 13.5%",
    }
    url = f"{SEARCH}/{key}?$select=doc_title&api-version=2026-08-01-preview"
    return {"id": f"doc-{key}", "content": json.dumps(source), "title": url, "url": url, "metadata": "application/json"}


def tool_call(query, documents, status="completed", error=None):
    return {
        "type": "mcp_call",
        "name": "knowledge_base_retrieve",
        "server_label": "annual_reports_kb",
        "arguments": json.dumps({"query_variants": [query]}),
        "output": json.dumps({"documents": documents}),
        "status": status,
        "error": error,
    }


def message(text, cited, phase="final_answer"):
    annotations = []
    for marker, key in cited:
        start = text.index(marker)
        annotations.append(
            {"type": "url_citation", "url": f"{SEARCH}/{key}?$select=doc_title&api-version=2026-08-01-preview",
             "start_index": start, "end_index": start + len(marker), "title": "source"}
        )
    return {
        "type": "message",
        "role": "assistant",
        "phase": phase,
        "content": [{"type": "output_text", "text": text, "annotations": annotations}],
    }


def agent_response(*output, status="completed"):
    return {
        "id": "resp_1",
        "status": status,
        "model": "gpt-5-6-sol",
        "agent_reference": {"type": "agent_reference", "name": "osfi-agent", "version": "3"},
        "usage": {"input_tokens": 33433, "output_tokens": 177, "output_tokens_details": {"reasoning_tokens": 12}},
        "output": [{"type": "mcp_list_tools", "tools": [{"name": "knowledge_base_retrieve"}]}, *output],
    }


COMPARISON = agent_response(
    tool_call("RBC CET1 ratio end fiscal 2025", [document("rbc-274", 116), document("rbc-271", 116)]),
    tool_call(
        "TD CET1 ratio end fiscal 2025",
        [document("td-190", 76, "TD Bank Group 2025 Annual Report", "TD 2025.pdf"), document("rbc-271", 116)],
    ),
    message(
        "| Bank | CET1 |\n|---|---:|\n| RBC | **13.5%** 【5:1†source】 |\n| TD | **14.7%** 【7:0†TD Bank Group】 |",
        [("【5:1†source】", "rbc-271"), ("【7:0†TD Bank Group】", "td-190")],
    ),
)


def test_annotated_markers_become_gate_markers_for_the_cited_documents():
    result = parse_response(COMPARISON)

    assert result.answer == "| Bank | CET1 |\n|---|---:|\n| RBC | **13.5%** [ref_id:1.2] |\n| TD | **14.7%** [ref_id:2.1] |"
    assert result.answer_raw.count("【") == 2
    # rbc-271 came back from both calls; it's one reference, first seen in call 1.
    assert [(ref["id"], ref["docKey"]) for ref in result.references] == [
        ("1.1", "rbc-274"), ("1.2", "rbc-271"), ("2.1", "td-190"),
    ]
    assert result.references[2]["sourceData"]["page_number_from"] == 76
    assert [(call.query, call.document_count) for call in result.tool_calls] == [
        ("RBC CET1 ratio end fiscal 2025", 2), ("TD CET1 ratio end fiscal 2025", 2),
    ]
    assert (result.agent_name, result.agent_version, result.model) == ("osfi-agent", "3", "gpt-5-6-sol")
    assert (result.input_tokens, result.output_tokens, result.reasoning_tokens) == (33433, 177, 12)


def test_unannotated_or_foreign_markers_are_left_for_the_gate_to_strip():
    data = agent_response(
        tool_call("RBC CET1", [document("rbc-274", 116)]),
        message("A 【4:2†source】. B 【4:0†source】.", [("【4:0†source】", "not-retrieved")]),
    )
    result = parse_response(data)
    assert result.answer == "A [ref_id:4:2]. B [ref_id:4:0]."

    gate = function_app.apply_gate(result.answer, result.references)
    assert gate.answer == "A. B."
    assert gate.unresolved_ref_ids == ["4:2", "4:0"]
    assert not gate.passed


def test_utf16_annotation_offsets_are_accepted():
    text = "\U0001F4C8 CET1 13.5% 【5:1†source】"
    data = agent_response(tool_call("RBC", [document("rbc-274", 116)]), message(text, []))
    marker = "【5:1†source】"
    utf16_start = len(text[: text.index(marker)].encode("utf-16-le")) // 2
    data["output"][-1]["content"][0]["annotations"] = [
        {"type": "url_citation", "url": f"{SEARCH}/rbc-274?$select=doc_title&api-version=2026-08-01-preview",
         "start_index": utf16_start, "end_index": utf16_start + len(marker)}
    ]
    assert parse_response(data).answer.endswith("13.5% [ref_id:1.1]")


def test_only_the_final_answer_is_shown():
    data = agent_response(
        message("Searching both reports.", [], phase="commentary"),
        tool_call("RBC", [document("rbc-274", 116)]),
        message("13.5% 【1:0†source】", [("【1:0†source】", "rbc-274")]),
    )
    assert parse_response(data).answer == "13.5% [ref_id:1.1]"


def test_malformed_tool_output_is_tolerated():
    data = agent_response(
        {"type": "mcp_call", "arguments": "not json", "output": "Tool failed", "status": "failed", "error": "403"},
        message("I couldn't search the reports.", []),
    )
    result = parse_response(data)
    assert result.references == []
    assert result.tool_calls == [ToolCall(query=None, status="failed", document_count=0, error="403")]


SETTINGS = Settings(
    search_endpoint="https://search.example", api_version="2026-08-01-preview", index_name="chunks",
    indexer_name="indexer", knowledge_source="reports", knowledge_base="kb",
    foundry_project_endpoint="https://foundry.example/api/projects/p", agent_name="osfi-agent",
)


def agent_service(session):
    credential = Mock()
    credential.get_token.return_value = Mock(token="test-token", expires_on=9_999_999_999)
    return AgentService(SETTINGS, credential, session)


def test_agent_runs_are_stateless_and_carry_the_conversation_as_input():
    session = Mock()
    session.post.return_value = Mock(status_code=200, json=Mock(return_value=COMPARISON))
    history = [{"role": "user", "text": "RBC's CET1?"}, {"role": "assistant", "text": "13.5%."}]
    result = agent_service(session).ask("And TD?", history)

    url, = session.post.call_args.args
    body = session.post.call_args.kwargs["json"]
    assert url == "https://foundry.example/api/projects/p/openai/v1/responses"
    assert body["agent_reference"] == {"type": "agent_reference", "name": "osfi-agent"}
    assert body["store"] is False
    assert body["input"] == [
        {"role": "user", "content": "RBC's CET1?"},
        {"role": "assistant", "content": "13.5%."},
        {"role": "user", "content": "And TD?"},
    ]
    assert session.post.call_args.kwargs["headers"]["Authorization"] == "Bearer test-token"
    assert "structured_inputs" not in body
    assert result.conversation["history_messages_used"] == 2


def test_the_users_search_token_goes_to_the_agent_as_a_structured_input():
    session = Mock()
    session.post.return_value = Mock(status_code=200, json=Mock(return_value=COMPARISON))
    agent_service(session).ask("RBC's CET1?", user_token="user-token")

    body = session.post.call_args.kwargs["json"]
    # agent/agent.json maps this input to the MCP tool's x-ms-query-source-authorization header.
    assert body["structured_inputs"] == {"search_auth_token": "user-token"}
    assert session.post.call_args.kwargs["headers"]["Authorization"] == "Bearer test-token"


def test_agent_http_failures_and_timeouts_raise_agent_errors():
    session = Mock()
    session.post.return_value = Mock(status_code=429, text="Too many requests")
    try:
        agent_service(session).ask("Question?")
    except AgentError as exc:
        assert exc.status == 429
    else:
        raise AssertionError("expected AgentError")
    session.post.side_effect = requests.Timeout()
    try:
        agent_service(session).ask("Question?")
    except AgentError as exc:
        assert exc.status == 504
    else:
        raise AssertionError("expected AgentError")


def test_a_dropped_connection_is_retried_once():
    session = Mock()
    ok = Mock(status_code=200, json=Mock(return_value=COMPARISON))
    session.post.side_effect = [requests.ConnectionError("reset"), ok]
    assert agent_service(session).ask("Question?").agent_version == "3"

    session.post.side_effect = [requests.ConnectionError("reset"), requests.ConnectionError("reset")]
    try:
        agent_service(session).ask("Question?")
    except AgentError as exc:
        assert exc.status == 502
    else:
        raise AssertionError("expected AgentError")
    assert session.post.call_count == 4


def ask(payload):
    handler = function_app.ask.build().get_user_function()
    request = func.HttpRequest(
        method="POST", url="http://localhost/api/ask", headers={"Content-Type": "application/json", **user_headers()},
        body=json.dumps(payload).encode("utf-8"),
    )
    response = handler(request)
    return response.status_code, json.loads(response.get_body())


def test_agent_mode_returns_gated_page_citations(monkeypatch):
    agent = Mock(configured=True)
    agent.ask.return_value = parse_response(COMPARISON)
    monkeypatch.setattr(function_app, "_agent_service", lambda: agent)
    status, data = ask({"question": "Compare RBC and TD CET1.", "mode": "agent"})

    assert status == 200
    assert data["mode"] == "agent"
    assert data["answer"].endswith("| RBC | **13.5%** [1] |\n| TD | **14.7%** [2] |")
    assert [(c["n"], c["label"], c["link"]) for c in data["citations"]] == [
        (1, "Royal Bank of Canada Annual Report 2025 — p. 116", "/api/docs/01RBC2025#page=116"),
        (2, "TD Bank Group 2025 Annual Report — p. 76", "/api/docs/01TD2025#page=76"),
    ]
    diagnostics = data["diagnostics"]
    assert diagnostics["gate_passed"] is True
    assert diagnostics["retrieve_status"] == 200
    assert (diagnostics["reference_count"], diagnostics["uncited_reference_count"]) == (3, 1)
    assert diagnostics["agent"] == {
        "name": "osfi-agent", "version": "3", "model": "gpt-5-6-sol", "response_id": "resp_1",
        "status": "completed", "tool_calls": 2,
    }
    assert diagnostics["activity"][0] == {
        "type": "knowledgeBaseCall", "query": "RBC CET1 ratio end fiscal 2025", "count": 2, "status": "completed",
    }
    assert "【" in diagnostics["answer_raw"]
    agent.ask.assert_called_once_with("Compare RBC and TD CET1.", [], user_token=USER_TOKEN)


def test_agent_mode_reports_skipped_search_partial_retrieval_and_incomplete_runs(monkeypatch):
    agent = Mock(configured=True)
    monkeypatch.setattr(function_app, "_agent_service", lambda: agent)

    agent.ask.return_value = AgentResult(answer_raw="From memory.", answer="From memory.", references=[])
    status, data = ask({"question": "Question?", "mode": "agent"})
    assert status == 200
    assert "The agent answered without searching the reports." in data["warnings"]

    agent.ask.return_value = AgentResult(
        answer_raw="Partial.", answer="Partial.", references=[], status="incomplete",
        incomplete_reason="max_output_tokens",
        tool_calls=[ToolCall("RBC", "completed", 2), ToolCall("TD", "failed", 0, error="timeout")],
    )
    status, data = ask({"question": "Question?", "mode": "agent"})
    assert data["diagnostics"]["retrieve_status"] == 206
    assert any(w.startswith("Partial retrieval") for w in data["warnings"])
    assert any("status incomplete (max_output_tokens)" in w for w in data["warnings"])
    assert data["diagnostics"]["activity"][1]["error"] == "timeout"


def test_agent_mode_errors(monkeypatch):
    agent = Mock(configured=False)
    monkeypatch.setattr(function_app, "_agent_service", lambda: agent)
    assert ask({"question": "Question?", "mode": "agent"})[0] == 503

    agent.configured = True
    agent.ask.side_effect = AgentError(500, "Internal error")
    status, data = ask({"question": "Question?", "mode": "agent"})
    assert (status, data["status"]) == (502, 500)

    agent.ask.side_effect = AgentError(504, "No response within 110 s.")
    assert ask({"question": "Question?", "mode": "agent"})[0] == 504


def test_direct_mode_is_the_default_and_labels_its_response(monkeypatch):
    search = Mock()
    search.retrieve.return_value = {"_httpStatus": 200, "response": [], "references": []}
    monkeypatch.setattr(function_app, "_services", lambda: (search, None))
    status, data = ask({"question": "Question?"})
    assert status == 200
    assert data["mode"] == data["diagnostics"]["mode"] == "direct"
    assert "agent" not in data["diagnostics"]
