"""The hand-written Python runtime.

Vendored verbatim into every generated SDK as `_core/`, so a generated package has **no dependency
on graft itself** — only on httpx and pydantic, which it would have chosen anyway.

Generated code is a thin surface over this. That split is where quality lives: this module is
reviewed and unit-tested by hand, and the generator's job is only to name things well.
"""

from ._client import (
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT,
    AsyncBaseClient,
    Auth,
    BaseClient,
)
from ._errors import (
    APIConnectionError,
    APIConnectionTimeoutError,
    APIError,
    APIStatusError,
    AuthenticationError,
    BadRequestError,
    ConflictError,
    InternalServerError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    SDKError,
    StreamDecodeError,
    UnprocessableEntityError,
    error_for_status,
)
from ._oauth2 import (
    AsyncTokenSource,
    OAuth2Config,
    OAuth2Error,
    TokenSource,
)
from ._pagination import (
    AsyncPage,
    AsyncPaginator,
    Page,
    PageInfo,
    Paginator,
    advance_cursor,
    advance_offset,
    advance_page_number,
)
from ._types import (
    NOT_GIVEN,
    Headers,
    HttpMethod,
    NotGiven,
    QueryValue,
    RequestOptions,
    build_query,
    compact_headers,
    encode_path,
    given,
    prune_body,
)

__all__ = [
    "DEFAULT_MAX_RETRIES",
    "DEFAULT_TIMEOUT",
    "NOT_GIVEN",
    "APIConnectionError",
    "APIConnectionTimeoutError",
    "APIError",
    "APIStatusError",
    "AsyncBaseClient",
    "AsyncPage",
    "AsyncPaginator",
    "AsyncTokenSource",
    "Auth",
    "AuthenticationError",
    "BadRequestError",
    "BaseClient",
    "ConflictError",
    "Headers",
    "HttpMethod",
    "InternalServerError",
    "NotFoundError",
    "NotGiven",
    "OAuth2Config",
    "OAuth2Error",
    "Page",
    "PageInfo",
    "Paginator",
    "PermissionDeniedError",
    "QueryValue",
    "RateLimitError",
    "RequestOptions",
    "SDKError",
    "StreamDecodeError",
    "TokenSource",
    "UnprocessableEntityError",
    "advance_cursor",
    "advance_offset",
    "advance_page_number",
    "build_query",
    "compact_headers",
    "encode_path",
    "error_for_status",
    "given",
    "prune_body",
]
