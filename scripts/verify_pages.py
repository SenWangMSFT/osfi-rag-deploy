"""Checks chunk page provenance against the source PDFs (plan Phase 1 exit: sampled chunks must cite the right page).

For each sampled chunk, every page of its PDF is scored by IDF-weighted word overlap with the chunk text.
A chunk passes when the best-matching page lies inside [page_number_from, page_number_to].

    python scripts/verify_pages.py                 # 25 random chunks
    python scripts/verify_pages.py --sample 100 --docs D:/reports
"""

from __future__ import annotations

import argparse
import logging
import math
import random
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path

from pypdf import PdfReader

from _common import ELEVATED_READ, ROOT, AzureClient, load_env, search_url

_WORD = re.compile(r"[a-z]{4,}|\d[\d,.]{2,}")


def tokens(text: str) -> set[str]:
    text = re.sub(r"<[^>]+>", " ", text or "").lower()
    return {t.rstrip(".,") for t in _WORD.findall(text)}


@lru_cache(maxsize=16)
def pdf_pages(path: Path) -> tuple[list[set[str]], dict[str, float]]:
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    pages = [tokens(page.extract_text() or "") for page in PdfReader(str(path)).pages]
    df = Counter(t for page in pages for t in page)
    idf = {t: math.log(len(pages) / n) for t, n in df.items()}
    return pages, idf


def best_page(chunk: set[str], pages: list[set[str]], idf: dict[str, float]) -> tuple[int, float]:
    weight = {t: idf.get(t, 0.0) for t in chunk}
    total = sum(weight.values()) or 1.0
    scores = [sum(weight[t] for t in chunk & page) / total for page in pages]
    index = max(range(len(scores)), key=scores.__getitem__)
    return index + 1, scores[index]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sample", type=int, default=25)
    parser.add_argument("--docs", type=Path, default=ROOT / "docs", help="folder with the source PDFs")
    args = parser.parse_args()

    env = load_env()
    client = AzureClient()
    url = search_url(env, f"indexes/{env['SEARCH_INDEX']}/docs/search")
    total = client.request("POST", url, body={"search": "*", "top": 0, "count": True}, headers=ELEVATED_READ).json()["@odata.count"]

    passed = checked = 0
    for skip in random.sample(range(total), min(args.sample, total)):
        body = {
            "search": "*", "top": 1, "skip": skip, "orderby": "chunk_id",
            "select": "chunk_id,doc_title,source_file,page_number_from,page_number_to,chunk_text",
        }
        doc = client.request("POST", url, body=body, headers=ELEVATED_READ).json()["value"][0]
        chunk = tokens(doc["chunk_text"])
        if not doc.get("source_file"):
            continue  # not tagged by the sync yet, so the file name isn't known
        pdf = args.docs / doc["source_file"]
        if len(chunk) < 8 or not pdf.exists():
            continue  # near-empty chunk (cover pages, figures) or PDF not available locally
        pages, idf = pdf_pages(pdf)
        page, score = best_page(chunk, pages, idf)
        low, high = doc["page_number_from"], doc["page_number_to"] or doc["page_number_from"]
        ok = low <= page <= high
        checked += 1
        passed += ok
        cited = f"p.{low}" if low == high else f"p.{low}-{high}"
        print(f"{'PASS' if ok else 'FAIL'}  {doc['doc_title'][:45]:<45} cited {cited:<10} best match p.{page} (score {score:.2f})")

    if checked:
        print(f"\n{passed}/{checked} chunks cite the page their text actually comes from ({passed / checked:.0%}).")


if __name__ == "__main__":
    main()
