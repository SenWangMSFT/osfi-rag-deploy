"""Keep recent, whole exchanges within the deployed model and request budgets."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache

import tiktoken

# GPT-5.6 Sol: 922,000 input tokens. Leave room for the KB's 16,000-token
# retrieved context and 8,000 tokens of service-managed instructions/overhead.
MODEL_INPUT_TOKENS = 922_000
DEFAULT_TOKEN_BUDGET = MODEL_INPUT_TOKENS - 16_000 - 8_000
# The agent reads every knowledge base result itself (about 16,000 tokens per call); leave room for several calls.
AGENT_TOKEN_BUDGET = MODEL_INPUT_TOKENS - 128_000 - 8_000
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_MESSAGE_BYTES = MAX_REQUEST_BYTES - 4096


class ContextBudgetError(ValueError):
    pass


@lru_cache(maxsize=1)
def _encoding() -> tiktoken.Encoding:
    return tiktoken.encoding_for_model("gpt-5.6-sol")


def message_tokens(message: dict[str, str]) -> int:
    # Text is exact; role/framing tokens are conservatively estimated.
    return len(_encoding().encode_ordinary(message["text"])) + len(_encoding().encode_ordinary(message["role"])) + 8


def message_bytes(message: dict[str, str]) -> int:
    wire = {"role": message["role"], "content": [{"type": "text", "text": message["text"]}]}
    return len(json.dumps(wire).encode("utf-8")) + 2


@dataclass(frozen=True)
class ConversationContext:
    history: list[dict[str, str]]
    estimated_input_tokens: int
    token_budget: int
    received: int

    @property
    def omitted(self) -> int:
        return self.received - len(self.history)

    def diagnostics(self) -> dict[str, int]:
        return {
            "history_messages_received": self.received,
            "history_messages_used": len(self.history),
            "history_messages_omitted": self.omitted,
            "estimated_input_tokens": self.estimated_input_tokens,
            "token_budget": self.token_budget,
        }


def select_context(
    question: str,
    history: list[dict[str, str]],
    token_budget: int = DEFAULT_TOKEN_BUDGET,
    byte_budget: int = MAX_MESSAGE_BYTES,
) -> ConversationContext:
    current = {"role": "user", "text": question}
    tokens = message_tokens(current)
    size = message_bytes(current)
    if tokens > token_budget or size > byte_budget:
        raise ContextBudgetError("The question exceeds the configured conversation context budget.")

    start = len(history)
    while start > 0:
        group_start = start - 1
        while group_start > 0 and history[group_start]["role"] != "user":
            group_start -= 1
        if history[group_start]["role"] != "user":
            break
        exchange = history[group_start:start]
        exchange_tokens = sum(message_tokens(message) for message in exchange)
        exchange_bytes = sum(message_bytes(message) for message in exchange)
        if tokens + exchange_tokens > token_budget or size + exchange_bytes > byte_budget:
            break
        tokens += exchange_tokens
        size += exchange_bytes
        start = group_start

    return ConversationContext(history[start:], tokens, token_budget, len(history))
