"""The signed-in user's Azure AI Search token, which web/server.mjs forwards with every /api call.

Search validates the token and filters every query by the user's groups; this module only rejects requests that
can't work, so the UI can tell "sign in" and "session expired" apart from other failures.
"""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Mapping

USER_TOKEN_HEADER = "x-search-user-token"
# Azure AI Search's application ID URI and application ID.
SEARCH_AUDIENCES = {"https://search.azure.com", "https://search.azure.com/", "880da380-985e-4198-81b9-e05b1cc53158"}
EXPIRY_MARGIN_S = 30


class UserTokenError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _claims(token: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise UserTokenError("invalid_token", "The sign-in token is malformed.")
    try:
        payload = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        claims = json.loads(payload)
    except ValueError as exc:
        raise UserTokenError("invalid_token", "The sign-in token is malformed.") from exc
    if not isinstance(claims, dict):
        raise UserTokenError("invalid_token", "The sign-in token is malformed.")
    return claims


def user_token(headers: Mapping[str, str], now: float | None = None) -> str:
    token = (headers.get(USER_TOKEN_HEADER) or "").strip()
    if not token:
        raise UserTokenError("sign_in_required", "Sign in to use this app.")
    claims = _claims(token)
    if claims.get("aud") not in SEARCH_AUDIENCES:
        raise UserTokenError("invalid_token", "The sign-in token isn't for Azure AI Search.")
    expires = claims.get("exp")
    if not isinstance(expires, (int, float)) or expires <= (time.time() if now is None else now) + EXPIRY_MARGIN_S:
        raise UserTokenError("token_expired", "Your sign-in has expired. Refresh the page to continue.")
    return token
