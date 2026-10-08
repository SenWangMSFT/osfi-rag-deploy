from rag.grounding import apply_gate


def ref(ref_id, page=47, page_to=None, title="Royal Bank of Canada Annual Report 2025", file="RBC Annual Report 2025.pdf"):
    return {
        "type": "searchIndex",
        "id": str(ref_id),
        "docKey": f"chunk-{ref_id}",
        "citationUrl": f"https://srch.search.windows.net/indexes/idx/docs/chunk-{ref_id}?api-version=x",
        "sourceData": {
            "doc_title": title,
            "page_number_from": page,
            "page_number_to": page if page_to is None else page_to,
            "source_file": file,
            "document_id": "01ABCDEFRBC2025",
            "chunk_text": "…",
        },
    }


def test_markers_are_renumbered_in_order_of_first_use():
    answer = "Net income was $16.2 billion [ref_id:3]. The CET1 ratio was 13.2% [ref_id:0]. Again [ref_id:3]."
    gate = apply_gate(answer, [ref(0, page=12), ref(3, page=47)])

    assert gate.answer == "Net income was $16.2 billion [1]. The CET1 ratio was 13.2% [2]. Again [1]."
    assert [(c["n"], c["ref_id"], c["page_from"]) for c in gate.citations] == [(1, "3", 47), (2, "0", 12)]
    assert gate.passed
    assert gate.uncited_reference_count == 0


def test_invented_marker_is_stripped_and_flagged():
    gate = apply_gate("CET1 was 13.2% [ref_id:9].", [ref(0)])

    assert gate.answer == "CET1 was 13.2%."
    assert gate.unresolved_ref_ids == ["9"]
    assert not gate.passed
    assert gate.citations == []
    assert any("match no retrieved source" in w for w in gate.warnings)


def test_reference_without_page_is_not_rendered():
    broken = ref(1)
    broken["sourceData"]["page_number_from"] = None
    gate = apply_gate("Revenue rose [ref_id:1].", [broken])

    assert gate.answer == "Revenue rose."
    assert gate.incomplete_ref_ids == ["1"]
    assert not gate.passed


def test_multi_id_marker_and_page_range_label():
    gate = apply_gate("Both figures appear in the tables [ref_id:0, ref_id:1].", [ref(0, page=4), ref(1, page=26, page_to=27)])

    assert gate.answer == "Both figures appear in the tables [1][2]."
    assert gate.citations[1]["label"] == "Royal Bank of Canada Annual Report 2025 — p. 26–27"
    # The link streams the SharePoint document; the file name is only for display.
    assert gate.citations[1]["link"] == "/api/docs/01ABCDEFRBC2025#page=26"
    assert gate.citations[1]["source_file"] == "RBC Annual Report 2025.pdf"


def test_reference_without_a_document_id_has_no_link():
    legacy = ref(0)
    del legacy["sourceData"]["document_id"]
    gate = apply_gate("CET1 was 13.2% [ref_id:0].", [legacy])

    assert gate.passed
    assert gate.citations[0]["link"] is None


def test_grounded_sentence_ratio_counts_marker_after_period():
    answer = (
        "Net income for fiscal 2025 was $16.2 billion. [ref_id:0]\n"
        "- The CET1 ratio closed the year at 13.2% [ref_id:1].\n"
        "- Dividends per share increased year over year.\n"
        "Summary:"
    )
    gate = apply_gate(answer, [ref(0), ref(1)])

    assert (gate.sentences_grounded, gate.sentences_total) == (2, 3)
    assert gate.grounded_sentence_ratio == 0.667


def test_answer_without_citations_warns():
    gate = apply_gate("The sources do not contain this information.", [ref(0)])

    assert gate.citations == []
    assert gate.uncited_reference_count == 1
    assert any("no verifiable citations" in w for w in gate.warnings)
