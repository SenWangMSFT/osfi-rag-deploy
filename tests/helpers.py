"""Shared test fixtures that aren't pytest fixtures: a user token the API's pre-checks accept."""

from __future__ import annotations

import base64
import json
import time


def fake_jwt(claims: dict) -> str:
    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'none', 'typ': 'JWT'})}.{part(claims)}.signature"


# Search validates the signature; the API only checks audience and expiry before calling it.
USER_TOKEN = fake_jwt({"aud": "https://search.azure.com", "exp": int(time.time()) + 3600, "oid": "user-1"})


def user_headers(token: str = USER_TOKEN) -> dict[str, str]:
    return {"x-search-user-token": token}
