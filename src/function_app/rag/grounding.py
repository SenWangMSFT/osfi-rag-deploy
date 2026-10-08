"""Grounding gate: every [ref_id:N] must resolve to a retrieved chunk that carries page provenance."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

_MARKER = re.compile(r"([ \t]*)\[ref_id:\s*([^\]]*)\]")
_RENDERED_MARKER = re.compile(r"\[\d+\]")
# "...billion. [1]" -> "...billion [1]." so a trailing marker counts for the sentence it follows.
_MARKERS_AFTER_TERMINATOR = re.compile(r"([.!?])((?:\s*\[\d+\])+)")
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+(?=[\"'(\[]?[A-Z0-9$])")
_LIST_PREFIX = re.compile(r"^\s*(?:[-*\u2022]|\d+[.)])\s+")
_REQUIRED_PROVENANCE = ("doc_title", "page_number_from")


@dataclass
class GateResult:
    answer: str
    citations: list[dict[str, Any]]
    warnings: list[str] = field(default_factory=list)
    unresolved_ref_ids: list[str] = field(default_factory=list)
    incomplete_ref_ids: list[str] = field(default_factory=list)
    uncited_reference_count: int = 0
    sentences_total: int = 0
    sentences_grounded: int = 0

    @property
    def passed(self) -> bool:
        return not self.unresolved_ref_ids and not self.incomplete_ref_ids

    @property
    def grounded_sentence_ratio(self) -> float | None:
        if not self.sentences_total:
            return None
        return round(self.sentences_grounded / self.sentences_total, 3)


def apply_gate(answer_text: str, references: list[dict[str, Any]], doc_route: str = "/api/docs") -> GateResult:
    """Rewrites [ref_id:N] as display numbers [1], [2]... and strips any marker that can't be verified."""
    refs = {str(ref["id"]): ref for ref in references if ref.get("id") is not None}
    numbering: dict[str, int] = {}
    unresolved: list[str] = []
    incomplete: list[str] = []

    def resolve(match: re.Match[str]) -> str:
        numbers: list[int] = []
        for token in re.split(r"[,;\s]+", match.group(2)):
            ref_id = token.strip().removeprefix("ref_id:").strip()
            if not ref_id:
                continue
            ref = refs.get(ref_id)
            if ref is None:
                unresolved.append(ref_id)  # the model cited something that wasn't retrieved
                continue
            source = ref.get("sourceData") or {}
            if any(source.get(name) in (None, "") for name in _REQUIRED_PROVENANCE):
                incomplete.append(ref_id)  # never render "page undefined"
                continue
            numbers.append(numbering.setdefault(ref_id, len(numbering) + 1))
        if not numbers:
            return ""
        return match.group(1) + "".join(f"[{n}]" for n in dict.fromkeys(numbers))

    answer = _MARKER.sub(resolve, answer_text or "").strip()
    total, grounded = _count_sentences(answer)
    result = GateResult(
        answer=answer,
        citations=[_citation(n, refs[ref_id], doc_route) for ref_id, n in numbering.items()],
        unresolved_ref_ids=list(dict.fromkeys(unresolved)),
        incomplete_ref_ids=list(dict.fromkeys(incomplete)),
        uncited_reference_count=len(refs) - len(numbering),
        sentences_total=total,
        sentences_grounded=grounded,
    )
    if result.unresolved_ref_ids:
        result.warnings.append(
            "Removed citation markers that match no retrieved source: ref_id " + ", ".join(result.unresolved_ref_ids)
        )
    if result.incomplete_ref_ids:
        result.warnings.append(
            "Removed citations whose source has no document title or page number (check the knowledge source "
            "sourceDataFields): ref_id " + ", ".join(result.incomplete_ref_ids)
        )
    if answer and not result.citations:
        result.warnings.append("The answer contains no verifiable citations.")
    return result


def _count_sentences(answer: str) -> tuple[int, int]:
    """Counts claim-like sentences and how many of them carry a verified citation."""
    text = _MARKERS_AFTER_TERMINATOR.sub(lambda m: f"{m.group(2)}{m.group(1)}", answer)
    total = grounded = 0
    for line in text.splitlines():
        line = _LIST_PREFIX.sub("", line).strip()
        if not line or set(line) <= set("|-: "):
            continue
        for sentence in _SENTENCE_BREAK.split(line):
            if len(re.findall(r"[A-Za-z]{2,}", sentence)) < 3:
                continue  # headings and fragments aren't claims
            total += 1
            grounded += bool(_RENDERED_MARKER.search(sentence))
    return total, grounded


def _citation(number: int, ref: dict[str, Any], doc_route: str) -> dict[str, Any]:
    source = ref.get("sourceData") or {}
    page_from = source.get("page_number_from")
    page_to = source.get("page_number_to")
    pages = f"p. {page_from}" if page_to in (None, page_from) else f"p. {page_from}–{page_to}"
    document_id = source.get("document_id")
    return {
        "n": number,
        "ref_id": str(ref.get("id")),
        "label": f"{source.get('doc_title')} — {pages}",
        "doc_title": source.get("doc_title"),
        "institution": source.get("institution"),
        "fiscal_year": source.get("fiscal_year"),
        "page_from": page_from,
        "page_to": page_to,
        "source_file": source.get("source_file"),
        "source_url": source.get("source_url"),
        # The SharePoint item ID that /api/docs streams.
        "document_id": document_id,
        # PDF page index (not the printed folio), so the viewer lands on the page the chunk came from.
        "link": f"{doc_route}/{quote(document_id, safe='')}#page={page_from}" if document_id else None,
        "citation_url": ref.get("citationUrl"),
        "doc_key": ref.get("docKey"),
        "reranker_score": ref.get("rerankerScore"),
        "excerpt": source.get("chunk_text"),
        "bounding_polygons": source.get("bounding_polygons"),
    }
