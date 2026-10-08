"""The site registry is validated before the sync sees it: a bad row could otherwise hide or expose an institution."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from onboard_sites import load_registry  # noqa: E402

HEADER = "institution_key,institution_name,site_url,site_id,group_ids,libraries,language\n"
GROUP = "11111111-1111-1111-1111-111111111111"


def registry(tmp_path: Path, *rows: str) -> Path:
    path = tmp_path / "institutions.csv"
    path.write_text(HEADER + "".join(f"{row}\n" for row in rows), encoding="utf-8")
    return path


def test_a_valid_registry_becomes_the_sync_format(tmp_path):
    sites = load_registry(registry(
        tmp_path,
        f"rbc,RBC,https://contoso.sharepoint.com/sites/osfi-poc-rbc,,{GROUP},,en",
        f'national-bank,National Bank,,"contoso.sharepoint.com,a,b",{GROUP};22222222-2222-2222-2222-222222222222,Documents;Archive,fr',
    ))
    assert sites[0] == {
        "institution_key": "rbc", "institution_name": "RBC", "site_url": "https://contoso.sharepoint.com/sites/osfi-poc-rbc",
        "site_id": "", "group_ids": [GROUP], "libraries": [], "language": "en",
    }
    assert sites[1]["site_id"] == "contoso.sharepoint.com,a,b"
    assert sites[1]["group_ids"] == [GROUP, "22222222-2222-2222-2222-222222222222"]
    assert sites[1]["libraries"] == ["Documents", "Archive"]


def test_every_problem_is_reported(tmp_path):
    with pytest.raises(ValueError) as error:
        load_registry(registry(
            tmp_path,
            f"RBC Bank,RBC,https://contoso.sharepoint.com/sites/rbc,,{GROUP},,en",
            "td,TD,http://example.com/sites/td,,,,en",
            f"td,TD again,https://contoso.sharepoint.com/sites/td,,not-a-guid,,en",
        ))
    message = str(error.value)
    assert "line 2: institution_key 'RBC Bank'" in message
    assert "line 3: site_url must be" in message
    assert "line 3: group_ids is empty" in message
    assert "line 4: institution_key 'td' appears twice" in message
    assert "line 4: group ID 'not-a-guid'" in message
