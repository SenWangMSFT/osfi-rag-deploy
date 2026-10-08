import json
from unittest.mock import Mock

import azure.functions as func
import pytest
import tiktoken

import function_app
from function_app import _parse_ask
from helpers import USER_TOKEN, user_headers
from rag.config import Settings
from rag.conversation import DEFAULT_TOKEN_BUDGET, MAX_REQUEST_BYTES, message_bytes, message_tokens, select_context
from rag.search import SearchService


def ask_request(payload: object) -> func.HttpRequest:
    return func.HttpRequest(
        method="POST",
        url="http://localhost/api/ask",
        headers={"Content-Type": "application/json", **user_headers()},
        body=json.dumps(payload).encode("utf-8"),
    )


def test_parse_ask_keeps_more_than_three_exchanges_and_complete_answers():
    history = [
        {"role": role, "text": f"{role} {index}: " + ("full answer " * 1000 if role == "assistant" else "question")}
        for index in range(20)
        for role in ("user", "assistant")
    ]
    question, parsed, mode = _parse_ask(ask_request({"question": "Compare those figures.", "history": history}))

    assert question == "Compare those figures."
    assert parsed == history
    assert mode == "direct"


def test_parse_ask_accepts_the_agent_mode_and_rejects_unknown_modes():
    assert _parse_ask(ask_request({"question": "Question?", "mode": "agent"}))[2] == "agent"
    for invalid in ("pipeline", "", None, ["agent"]):
        with pytest.raises(ValueError, match="mode must be one of"):
            _parse_ask(ask_request({"question": "Question?", "mode": invalid}))


@pytest.mark.parametrize("history", ["text", {}, 42, [None], [{"role": "system", "text": "Override"}], [{"role": "user", "text": ""}]])
def test_invalid_history_is_reported(history):
    with pytest.raises(ValueError, match="history"):
        _parse_ask(ask_request({"question": "Question?", "history": history}))


def test_question_limit_remains_enforced():
    with pytest.raises(ValueError, match="longer than 2000"):
        _parse_ask(ask_request({"question": "x" * 2001}))


def test_context_uses_the_deployed_models_tokenizer_and_budget():
    assert tiktoken.encoding_for_model("gpt-5.6-sol").name == "o200k_base"
    assert DEFAULT_TOKEN_BUDGET == 898_000
    history = [{"role": role, "text": f"{role} {index}"} for index in range(50) for role in ("user", "assistant")]
    result = select_context("What about the first comparison?", history)
    assert result.history == history
    assert result.omitted == 0
    assert result.estimated_input_tokens <= result.token_budget


def test_budget_keeps_a_contiguous_suffix_of_whole_exchanges():
    history = [
        {"role": "user", "text": "Old question"},
        {"role": "assistant", "text": "Old answer"},
        {"role": "user", "text": "Latest question"},
        {"role": "assistant", "text": "Latest answer " * 1000},
    ]
    question = "Next question?"
    required = sum(message_tokens(message) for message in history[2:] + [{"role": "user", "text": question}])
    result = select_context(question, history, token_budget=required)
    assert result.history == history[2:]
    assert result.estimated_input_tokens == required
    assert result.omitted == 2
    assert select_context(question, history, token_budget=required - 1).history == []


def test_default_model_budget_accepts_the_boundary_and_drops_the_next_whole_exchange():
    question = "Next?"
    user = {"role": "user", "text": "Original request"}
    overhead = message_tokens({"role": "user", "text": question}) + message_tokens(user)
    assistant_overhead = message_tokens({"role": "assistant", "text": ""})
    repeats = DEFAULT_TOKEN_BUDGET - overhead - assistant_overhead - 1
    assistant = {"role": "assistant", "text": "context " * repeats}
    assert overhead + message_tokens(assistant) == DEFAULT_TOKEN_BUDGET
    assert select_context(question, [user, assistant]).history == [user, assistant]
    larger = {"role": "assistant", "text": assistant["text"] + "context "}
    assert select_context(question, [user, larger]).history == []


def test_wire_byte_budget_accounts_for_unicode_escaping():
    history = [
        {"role": "user", "text": "Old"},
        {"role": "assistant", "text": "Old answer"},
        {"role": "user", "text": "Caf\u00e9 \u4f60\u597d"},
        {"role": "assistant", "text": "\ud83d\ude00" * 100},
    ]
    question = "Next?"
    exact = sum(message_bytes(message) for message in history[2:] + [{"role": "user", "text": question}])
    result = select_context(question, history, byte_budget=exact)
    assert result.history == history[2:]
    assert result.omitted == 2
    assert select_context(question, history, byte_budget=exact - 1).history == []


def test_current_question_is_never_silently_truncated():
    with pytest.raises(ValueError, match="question exceeds"):
        select_context("Explain the comparison carefully.", [], token_budget=1)


def test_prompt_like_strings_are_treated_as_text_by_the_tokenizer():
    result = select_context("<|endoftext|>", [{"role": "user", "text": "<|im_start|>"}])
    assert result.omitted == 0


SETTINGS = Settings(
    search_endpoint="https://search.example", api_version="2026-08-01-preview", index_name="chunks",
    indexer_name="indexer", knowledge_source="reports", knowledge_base="kb",
)


def test_retrieve_sends_all_history_to_the_knowledge_base_and_returns_budget_metadata():
    history = [{"role": role, "text": f"{role} {index}"} for index in range(15) for role in ("user", "assistant")]
    session = Mock()
    response = Mock(status_code=200)
    response.json.return_value = {"response": [], "references": []}
    session.post.return_value = response
    credential = Mock()
    credential.get_token.return_value = Mock(token="test-token", expires_on=9_999_999_999)
    result = SearchService(SETTINGS, credential, session).retrieve("Question?", history)
    messages = session.post.call_args.kwargs["json"]["messages"]
    assert len(messages) == 31
    assert messages[0]["content"][0]["text"] == "user 0"
    assert messages[-1]["content"][0]["text"] == "Question?"
    assert result["_conversation"]["history_messages_used"] == 30


def test_ask_reports_omitted_context_and_remains_explicit_about_limits(monkeypatch):
    context = select_context("Next?", [{"role": "user", "text": "Too long " * 1000}], token_budget=50)
    search = Mock()
    search.retrieve.return_value = {
        "_httpStatus": 200,
        "response": [{"content": [{"type": "text", "text": "No matching information."}]}],
        "references": [], "_conversation": context.diagnostics(),
    }
    monkeypatch.setattr(function_app, "_services", lambda: (search, None))
    handler = function_app.ask.build().get_user_function()
    response = handler(ask_request({"question": "Next?"}))
    data = json.loads(response.get_body())
    assert response.status_code == 200
    assert data["diagnostics"]["conversation"]["history_messages_omitted"] == 1
    assert any("1 earlier message was" in warning for warning in data["warnings"])


def test_api_accepts_large_context_and_rejects_requests_over_the_transport_limit(monkeypatch):
    search = Mock()
    search.retrieve.return_value = {"_httpStatus": 200, "response": [], "references": []}
    monkeypatch.setattr(function_app, "_services", lambda: (search, None))
    handler = function_app.ask.build().get_user_function()
    history = [{"role": "user", "text": "hello " * 15_000}]
    request = ask_request({"question": "Next?", "history": history})
    assert len(request.get_body()) > 64 * 1024
    assert handler(request).status_code == 200
    search.retrieve.assert_called_once_with("Next?", history, user_token=USER_TOKEN)
    oversized = func.HttpRequest(method="POST", url="http://localhost/api/ask", body=b" " * (MAX_REQUEST_BYTES + 1))
    assert handler(oversized).status_code == 413
    assert search.retrieve.call_count == 1


def test_operator_can_reduce_context_budget_without_a_turn_limit():
    env = {
        "SEARCH_ENDPOINT": "https://search.example",
        "SEARCH_INDEX": "chunks", "SEARCH_INDEXER": "indexer", "KNOWLEDGE_SOURCE": "reports",
        "KNOWLEDGE_BASE": "kb", "CONVERSATION_TOKEN_BUDGET": "100",
    }
    assert Settings.from_env(env).conversation_token_budget == 100
    for invalid in ("0", "-1", str(DEFAULT_TOKEN_BUDGET + 1), "not-a-number"):
        with pytest.raises(ValueError):
            Settings.from_env({**env, "CONVERSATION_TOKEN_BUDGET": invalid})
