"""The exception hierarchy.

Narrowing by ``except`` is Python's own mechanism, so the taxonomy is a class tree rather than an
error-code enum. `SDKError` is named for its **role**, never for the generator: generated code
aliases it to `<ClientName>Error`, so renaming this project can never be a breaking change for an
SDK it produced (AGENTS.md).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import httpx

__all__ = [
    "APIConnectionError",
    "APIConnectionTimeoutError",
    "APIError",
    "APIStatusError",
    "AuthenticationError",
    "BadRequestError",
    "ConflictError",
    "InternalServerError",
    "NotFoundError",
    "PermissionDeniedError",
    "RateLimitError",
    "SDKError",
    "StreamDecodeError",
    "UnprocessableEntityError",
    "error_for_status",
]


class SDKError(Exception):
    """Base class for everything this SDK raises.

    ``except SDKError`` is the one guarantee callers get: no exception escapes an SDK method without
    being one of these, so a caller can distinguish "the SDK failed" from "my own code failed"
    without enumerating types.
    """


class APIError(SDKError):
    """A request reached the API and came back unsuccessfully."""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        body: object = None,
        request_id: str | None = None,
        response: httpx.Response | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.body = body
        # Surfaced deliberately: it is the first thing an API's support team asks for, and an SDK
        # that swallows it makes its users read raw responses to get it back.
        self.request_id = request_id
        self.response = response

    def __str__(self) -> str:
        parts = [self.message]
        if self.status is not None:
            parts.append(f"(status {self.status})")
        if self.request_id is not None:
            parts.append(f"(request_id {self.request_id})")
        return " ".join(parts)


class APIStatusError(APIError):
    """An error carrying an HTTP status. Subclasses pin ``status`` to one value."""


class BadRequestError(APIStatusError):
    """HTTP 400."""


class AuthenticationError(APIStatusError):
    """HTTP 401."""


class PermissionDeniedError(APIStatusError):
    """HTTP 403."""


class NotFoundError(APIStatusError):
    """HTTP 404."""


class ConflictError(APIStatusError):
    """HTTP 409."""


class UnprocessableEntityError(APIStatusError):
    """HTTP 422."""


class RateLimitError(APIStatusError):
    """HTTP 429.

    ``retry_after`` is parsed from the response so callers who handle backoff themselves do not have
    to re-read headers the runtime already looked at.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        body: object = None,
        request_id: str | None = None,
        response: httpx.Response | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(
            message,
            status=status,
            body=body,
            request_id=request_id,
            response=response,
        )
        self.retry_after = retry_after


class InternalServerError(APIStatusError):
    """HTTP 5xx."""


class APIConnectionError(APIError):
    """The request never produced a response — DNS, TLS, or a dropped connection."""


class APIConnectionTimeoutError(APIConnectionError):
    """The request timed out."""


class StreamDecodeError(SDKError):
    """A streamed response contained a chunk that could not be decoded."""

    def __init__(self, message: str, *, raw: str | None = None) -> None:
        super().__init__(message)
        self.raw = raw


_BY_STATUS: dict[int, type[APIStatusError]] = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableEntityError,
    429: RateLimitError,
}


def error_for_status(status: int) -> type[APIStatusError]:
    """The most specific exception class for a status code.

    Falls back by *class* of status rather than raising on an unknown code: a 418 must still arrive
    as an ``APIStatusError`` a caller can catch, not as a runtime failure inside the SDK.
    """
    specific = _BY_STATUS.get(status)
    if specific is not None:
        return specific
    if status >= 500:
        return InternalServerError
    return APIStatusError
