"""Structured telemetry. Each event is one log line; App Insights stores it in the traces table."""

from __future__ import annotations

import json
import logging
from typing import Any

_log = logging.getLogger("rag.telemetry")
_TOKEN_FIELDS = (("inputTokens", "input_tokens"), ("outputTokens", "output_tokens"), ("reasoningTokens", "reasoning_tokens"))


def summarize_activity(activity: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Per-stage latency and token counts from the retrieve activity array."""
    stages: list[dict[str, Any]] = []
    totals = {target: 0 for _, target in _TOKEN_FIELDS}
    for record in activity or []:
        stage: dict[str, Any] = {"type": record.get("type"), "elapsed_ms": record.get("elapsedMs")}
        for source, target in _TOKEN_FIELDS:
            if isinstance(record.get(source), int):
                stage[target] = record[source]
                totals[target] += record[source]
        if record.get("type") == "searchIndex":
            stage["count"] = record.get("count")
            stage["query"] = (record.get("searchIndexArguments") or {}).get("search")
        if record.get("error"):
            stage["error"] = record["error"]
        stages.append(stage)
    return {"stages": stages, **totals}


def emit(event: str, payload: dict[str, Any]) -> None:
    _log.info("%s %s", event, json.dumps(payload, default=str, ensure_ascii=False))
