"""OAuth2 token acquisition.

Only the flows an SDK can honestly own (SPEC.md §3.1.6): ``clientCredentials``, where the SDK holds
the credentials and is entirely responsible, and refreshing a token the caller obtained elsewhere.
The
authorization-code redirect needs a browser and a human, so it stays the application's job.

There are **two** token sources here, sync and async, because there are two clients. They are
deliberately near-identical: the only difference is which lock they take, and merging them would
mean
the sync path driving an event loop — which breaks for a caller who already has one running, and
most
callers do.

The token request itself is the easy part. What earns this module are the three things around it:
single-flight refresh, proactive expiry, and retrying a 401 exactly once.
"""

from __future__ import annotations

import asyncio
import base64
import threading
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

import httpx

from ._errors import SDKError

if TYPE_CHECKING:
    from collections.abc import Sequence

__all__ = [
    "AsyncTokenSource",
    "OAuth2Config",
    "OAuth2Error",
    "TokenSource",
]

# How early to treat a token as expired.
#
# Refreshing only once a token has *already* expired guarantees at least one failed request first.
# Thirty seconds covers ordinary clock skew and the time a request spends in flight.
_EXPIRY_SKEW_SECONDS = 30.0


@dataclass(frozen=True, slots=True)
class OAuth2Config:
    """How the SDK obtains a token."""

    flow: Literal["client_credentials", "refresh_token"]
    token_url: str
    client_id: str | None = None
    client_secret: str | None = None
    refresh_token: str | None = None
    scopes: Sequence[str] | None = None
    # ``basic`` sends the credentials in an Authorization header, ``body`` in the form body.
    #
    # RFC 6749 requires servers to support ``basic`` and says ``body`` *may* be supported, so
    # ``basic``
    # is the default — but real servers get this wrong in both directions, which is why it is an
    # option
    # rather than a constant.
    client_auth: Literal["basic", "body"] = "basic"
    extra_params: dict[str, str] | None = None


@dataclass(frozen=True, slots=True)
class _CachedToken:
    access_token: str
    # Monotonic deadline, already adjusted by the skew. ``None`` means the server declared no
    # expiry.
    usable_until: float | None
    # A rotated refresh token, when the server issued one.
    refresh_token: str | None

    @property
    def expired(self) -> bool:
        return self.usable_until is not None and time.monotonic() >= self.usable_until


class OAuth2Error(SDKError):
    """Raised when the authorization server refuses to issue a token."""

    def __init__(self, message: str, *, status: int, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        # The RFC 6749 ``error`` code, e.g. ``invalid_client``.
        self.code = code

    def __str__(self) -> str:
        if self.code is not None:
            return f"{self.message} ({self.code}, status {self.status})"
        return f"{self.message} (status {self.status})"


def _request_form(
    config: OAuth2Config, current: _CachedToken | None
) -> tuple[dict[str, str], dict[str, str]]:
    """Build the form body and headers for a token request."""
    form: dict[str, str] = {}
    headers = {"Accept": "application/json"}

    if config.flow == "client_credentials":
        form["grant_type"] = "client_credentials"
    else:
        form["grant_type"] = "refresh_token"
        # The rotated token when the server issued one, otherwise the caller's original. A server
        # that
        # rotates refresh tokens invalidates the old one, so reusing it would fail on the *second*
        # refresh — a bug that only appears after a token lifetime has elapsed.
        rotated = current.refresh_token if current is not None else None
        token = rotated or config.refresh_token
        if token is None:
            raise OAuth2Error("No refresh token available", status=0)
        form["refresh_token"] = token

    if config.scopes:
        form["scope"] = " ".join(config.scopes)
    if config.extra_params:
        form.update(config.extra_params)

    if config.client_id is not None:
        if config.client_auth == "basic":
            secret = config.client_secret or ""
            encoded = base64.b64encode(f"{config.client_id}:{secret}".encode()).decode("ascii")
            headers["Authorization"] = f"Basic {encoded}"
        else:
            form["client_id"] = config.client_id
            if config.client_secret is not None:
                form["client_secret"] = config.client_secret

    return form, headers


def _parse_response(response: httpx.Response, current: _CachedToken | None) -> _CachedToken:
    """Turn a token response into a cached token, or raise.

    Never retried on failure. A 400 from a token endpoint means the credentials are wrong, and
    retrying
    it is both pointless and indistinguishable from a brute-force attempt.
    """
    try:
        payload: Any = response.json()
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    if response.status_code >= 400:
        code = payload.get("error") if isinstance(payload.get("error"), str) else None
        description = payload.get("error_description")
        message = (
            description
            if isinstance(description, str) and description
            else code or f"The token endpoint returned {response.status_code}"
        )
        raise OAuth2Error(message, status=response.status_code, code=code)

    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or access_token == "":
        raise OAuth2Error(
            "The token endpoint returned no access_token", status=response.status_code
        )

    expires_in = payload.get("expires_in")
    usable_until: float | None = None
    if isinstance(expires_in, (int, float)) and not isinstance(expires_in, bool):
        usable_until = time.monotonic() + max(0.0, float(expires_in) - _EXPIRY_SKEW_SECONDS)

    rotated = payload.get("refresh_token")
    return _CachedToken(
        access_token=access_token,
        usable_until=usable_until,
        refresh_token=rotated
        if isinstance(rotated, str) and rotated
        else (current.refresh_token if current is not None else None),
    )


class TokenSource:
    """Acquires and caches OAuth2 tokens for the synchronous client.

    One instance per client, so a client shared across a request handler shares one token rather
    than
    fetching one per call.
    """

    def __init__(self, config: OAuth2Config, http_client: httpx.Client) -> None:
        self._config = config
        self._client = http_client
        self._cached: _CachedToken | None = None
        # The single-flight mechanism. Ten concurrent threads on a cold client must produce **one**
        # token request: without this, the first thing a new SDK does under load is hammer the
        # authorization server, and the symptom is unexplained 429s from a host nobody configured.
        self._lock = threading.Lock()

    def token(self) -> str:
        current = self._cached
        if current is not None and not current.expired:
            return current.access_token
        return self._refresh()

    def force_refresh(self) -> str:
        """Discard the cached token and fetch a new one.

        Called on a 401 as well as on expiry, because expiry arithmetic is necessary but not
        sufficient — clocks disagree and servers revoke tokens early.
        """
        with self._lock:
            self._cached = None
        return self._refresh()

    def _refresh(self) -> str:
        with self._lock:
            # Re-checked inside the lock: a caller that queued behind another thread's refresh
            # should
            # use its result rather than immediately fetching again.
            current = self._cached
            if current is not None and not current.expired:
                return current.access_token
            form, headers = _request_form(self._config, current)
            response = self._client.post(self._config.token_url, data=form, headers=headers)
            token = _parse_response(response, current)
            self._cached = token
            return token.access_token


class AsyncTokenSource:
    """The asynchronous twin of :class:`TokenSource`."""

    def __init__(self, config: OAuth2Config, http_client: httpx.AsyncClient) -> None:
        self._config = config
        self._client = http_client
        self._cached: _CachedToken | None = None
        # Created lazily: constructing an asyncio.Lock outside a running loop is deprecated, and a
        # client is often built before the loop exists.
        self._lock: asyncio.Lock | None = None

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def token(self) -> str:
        current = self._cached
        if current is not None and not current.expired:
            return current.access_token
        return await self._refresh()

    async def force_refresh(self) -> str:
        async with self._get_lock():
            self._cached = None
        return await self._refresh()

    async def _refresh(self) -> str:
        async with self._get_lock():
            current = self._cached
            if current is not None and not current.expired:
                return current.access_token
            form, headers = _request_form(self._config, current)
            response = await self._client.post(self._config.token_url, data=form, headers=headers)
            token = _parse_response(response, current)
            self._cached = token
            return token.access_token
