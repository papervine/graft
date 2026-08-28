"""Transport, auth, and retries.

The sync and async clients are deliberately near-identical: `httpx` gives both the same API, so the
duplication is confined to `def`/`async def` and the two lines that await. The alternative — one
implementation with the sync path driving an event loop — breaks for callers who already have a
running loop, which is most of them.
"""

from __future__ import annotations

import email.utils
import json
import random
import time
from typing import TYPE_CHECKING, Any, Literal, TypeVar
from urllib.parse import urlencode

import httpx

from ._errors import (
    APIConnectionError,
    APIConnectionTimeoutError,
    APIError,
    RateLimitError,
    error_for_status,
)

# A runtime import, not a TYPE_CHECKING one: the retry loop does `isinstance(source, TokenSource)`
# to pick the sync or async path, so the names must exist at run time.
from ._oauth2 import AsyncTokenSource, TokenSource
from ._types import (
    HttpMethod,
    NotGiven,
    QueryValue,
    RequestOptions,
    build_query,
    compact_headers,
    prune_body,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Iterator, Mapping

__all__ = ["DEFAULT_MAX_RETRIES", "DEFAULT_TIMEOUT", "AsyncBaseClient", "Auth", "BaseClient"]

T = TypeVar("T")

DEFAULT_TIMEOUT = 60.0
DEFAULT_MAX_RETRIES = 2

# Retried because the request either never arrived or the server said to try again. A 4xx other
# than 429 is not retried: the request was understood and rejected, so sending it again is load.
_RETRY_STATUSES = frozenset({408, 409, 429, 500, 502, 503, 504})

# Methods HTTP defines as idempotent, which are therefore safe to replay.
#
# `DELETE` belongs here: deleting twice leaves the resource deleted, and a 404 on the second attempt
# is
# the correct answer rather than a failure.
#
# The absence of this check was a bug, not a missing feature: a `POST /charges` returning 503 was
# sent
# three times, and whether the server processed the first one is unknowable from the client.
_IDEMPOTENT_METHODS = frozenset({"get", "head", "put", "delete", "options"})

# Not standardised — `Idempotency-Key`, `X-Idempotency-Key`, and `Idempotency-Token` are all in real
# use — so a generated client can override it.
DEFAULT_IDEMPOTENCY_HEADER = "Idempotency-Key"

_MAX_BACKOFF = 8.0


class Auth:
    """How to authenticate.

    One class rather than a hierarchy, because a client picks exactly one scheme.
    """

    __slots__ = ("kind", "location", "password", "source", "token", "username", "wire_name")

    def __init__(
        self,
        kind: Literal["none", "bearer", "basic", "api_key", "oauth2"],
        *,
        token: str | None = None,
        username: str | None = None,
        password: str | None = None,
        wire_name: str | None = None,
        location: Literal["header", "query"] = "header",
        source: TokenSource | AsyncTokenSource | None = None,
    ) -> None:
        self.kind = kind
        self.token = token
        self.username = username
        self.password = password
        self.wire_name = wire_name
        self.location = location
        # For `oauth2`: the header cannot be computed once at construction, because it depends on a
        # token that may not exist yet and will be replaced.
        self.source = source

    def __repr__(self) -> str:
        # Never interpolate the credential. A repr lands in logs and exception context, and an SDK
        # that leaks its own token there has done real damage that is very hard to undo.
        return f"Auth(kind={self.kind!r})"


def _retry_delay(attempt: int, response: httpx.Response | None) -> float:
    """How long to wait before retry number ``attempt`` (1-based).

    The server's own `Retry-After` wins when present — it knows its rate limit window and we do not.
    Both integer-seconds and HTTP-date forms are accepted, because both appear in the wild.

    Otherwise exponential backoff with **full jitter**: ``random() * 2**attempt``, not
    ``2**attempt`` plus a small wobble. Deterministic backoff synchronises every client that started
    at the same time — a thundering herd that arrives together, fails together, and retries
    together. Full jitter is what spreads them.
    """
    if response is not None:
        header = response.headers.get("retry-after")
        if header is not None:
            try:
                return max(0.0, min(float(header), _MAX_BACKOFF * 4))
            except ValueError:
                parsed = email.utils.parsedate_to_datetime(header)
                if parsed is not None:
                    delta = parsed.timestamp() - time.time()
                    return max(0.0, min(delta, _MAX_BACKOFF * 4))
    # Jitter spreads retries; it is not a security primitive.
    return random.uniform(0, min(_MAX_BACKOFF, 0.5 * (2**attempt)))  # noqa: S311


def _request_id(response: httpx.Response) -> str | None:
    for name in ("x-request-id", "request-id", "x-amzn-requestid", "cf-ray"):
        value: str | None = response.headers.get(name)
        if value is not None:
            return value
    return None


def _error_body(response: httpx.Response) -> object:
    """The parsed error body, or the raw text when it is not JSON.

    Never raises: this runs while constructing an exception, and a decode failure here would replace
    a useful "404 Not Found" with a confusing JSONDecodeError from inside the SDK.
    """
    try:
        return response.json()
    except (ValueError, UnicodeDecodeError):
        try:
            return response.text
        except (ValueError, UnicodeDecodeError):
            return None


def _raise_for_status(response: httpx.Response) -> None:
    body = _error_body(response)
    request_id = _request_id(response)
    message = f"{response.status_code} {response.reason_phrase or 'Error'}"
    if isinstance(body, dict):
        for key in ("message", "error", "detail", "title"):
            candidate = body.get(key)
            if isinstance(candidate, str) and candidate:
                message = candidate
                break
            if isinstance(candidate, dict):
                nested = candidate.get("message")
                if isinstance(nested, str) and nested:
                    message = nested
                    break

    if response.status_code == 429:
        header = response.headers.get("retry-after")
        retry_after: float | None = None
        if header is not None:
            try:
                retry_after = float(header)
            except ValueError:
                retry_after = None
        raise RateLimitError(
            message,
            status=response.status_code,
            body=body,
            request_id=request_id,
            response=response,
            retry_after=retry_after,
        )

    raise error_for_status(response.status_code)(
        message,
        status=response.status_code,
        body=body,
        request_id=request_id,
        response=response,
    )


class _ClientBase:
    """State and request assembly shared by the sync and async clients."""

    def __init__(
        self,
        *,
        base_url: str,
        auth: Auth,
        timeout: float | None = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        user_agent: str | None = None,
        idempotency_header: str = DEFAULT_IDEMPOTENCY_HEADER,
    ) -> None:
        self._idempotency_header = idempotency_header
        self._base_url = base_url.rstrip("/")
        self._auth = auth
        self._timeout = timeout
        # Clamped, not trusted. `-1` is a natural way to write "no retries" — the TypeScript and
        # Go runtimes both accept it — and storing it raw made the retry loop run *zero* times, so
        # every request failed with "no recorded error". A negative retry count has no other
        # sensible meaning, so it becomes zero here rather than at each use.
        self._max_retries = max(0, max_retries)
        self._default_headers = dict(default_headers or {})
        if user_agent is not None:
            self._default_headers.setdefault("User-Agent", user_agent)

    @property
    def base_url(self) -> str:
        return self._base_url

    def _url(self, path: str) -> str:
        return f"{self._base_url}/{path.lstrip('/')}"

    def _headers(
        self,
        options: RequestOptions | None,
        extra: Mapping[str, object] | None,
        oauth_token: str | None = None,
    ) -> dict[str, str]:
        """Assemble request headers.

        ``oauth_token`` is resolved by the caller rather than fetched here: fetching is asynchronous
        on the async client and synchronous on the sync one, and this method is shared by both.
        Threading the resolved value keeps one implementation of the header rules rather than two
        that
        would drift.
        """
        headers = dict(self._default_headers)
        headers.update(compact_headers(extra))
        if oauth_token is not None:
            headers["Authorization"] = f"Bearer {oauth_token}"
        elif self._auth.kind == "bearer" and self._auth.token is not None:
            headers["Authorization"] = f"Bearer {self._auth.token}"
        elif (
            self._auth.kind == "api_key"
            and self._auth.location == "header"
            and self._auth.token is not None
            and self._auth.wire_name is not None
        ):
            headers[self._auth.wire_name] = self._auth.token
        if options is not None and options.extra_headers is not None:
            headers.update(options.extra_headers)
        if options is not None and options.idempotency_key is not None:
            headers[self._idempotency_header] = options.idempotency_key
        return headers

    def _query(
        self,
        params: Mapping[str, QueryValue] | None,
        options: RequestOptions | None,
    ) -> list[tuple[str, str]]:
        pairs = build_query(params)
        if (
            self._auth.kind == "api_key"
            and self._auth.location == "query"
            and self._auth.token is not None
            and self._auth.wire_name is not None
        ):
            pairs.append((self._auth.wire_name, self._auth.token))
        if options is not None and options.extra_query is not None:
            pairs.extend(build_query(options.extra_query))
        return pairs

    def _httpx_auth(self) -> httpx.Auth | None:
        if self._auth.kind == "basic" and self._auth.username is not None:
            return httpx.BasicAuth(self._auth.username, self._auth.password or "")
        return None

    def _timeout_for(self, options: RequestOptions | None) -> float | None:
        if options is not None and not isinstance(options.timeout, NotGiven):
            return options.timeout
        return self._timeout

    def _replayable(self, method: HttpMethod, options: RequestOptions | None) -> bool:
        """Whether replaying this request is safe.

        `POST` and `PATCH` are replayable only with an idempotency key, because deduplication
        happens on the *server*. Pretending otherwise is worse than not retrying: the belief is what
        stops someone thinking about it.
        """
        if method.lower() in _IDEMPOTENT_METHODS:
            return True
        return options is not None and options.idempotency_key is not None

    def _retries_for(self, options: RequestOptions | None) -> int:
        if options is not None and not isinstance(options.max_retries, NotGiven):
            # Clamped for the same reason as the client-level value: a negative count would make the
            # retry loop run zero times rather than once.
            return max(0, options.max_retries)
        return self._max_retries

    def _build(
        self,
        client: httpx.Client | httpx.AsyncClient,
        *,
        method: HttpMethod,
        path: str,
        query: Mapping[str, QueryValue] | None,
        body: object,
        files: object,
        headers: Mapping[str, object] | None,
        options: RequestOptions | None,
        oauth_token: str | None = None,
        body_kind: str = "json",
    ) -> httpx.Request:
        # The per-call timeout is applied to the *request*, not left on the client: the client is
        # shared across every call, so setting it there would leak one call's override into the
        # next. httpx keeps it in `request.extensions`, which `send` honours.
        kwargs: dict[str, Any] = {
            "method": method.upper(),
            "url": self._url(path),
            "params": self._query(query, options) or None,
            "headers": self._headers(options, headers, oauth_token),
            "timeout": self._timeout_for(options),
        }
        if files is not None:
            # multipart: the body's fields ride alongside the files as form data, which is what
            # `multipart/form-data` means. Passing `json=` here instead silently drops the files.
            kwargs["files"] = files
            if isinstance(body, dict):
                kwargs["data"] = {k: v for k, v in prune_body(body).items() if v is not None}
        elif body_kind == "multipart" and body is not None and not isinstance(body, NotGiven):
            # The body carries the files: a `format: binary` field is `bytes` in Python, so the
            # runtime splits by *value type* rather than being handed pre-built parts. That is
            # what the TypeScript runtime does with `Blob`, and doing it here means one
            # implementation of "which field is a file" instead of six.
            #
            # httpx sets the content type and generates the boundary from `files=`; setting it
            # here would produce a request no server can parse, the boundary being absent.
            file_parts, fields = _split_multipart(prune_body(body, json_mode=False))
            kwargs["files"] = file_parts
            if fields:
                kwargs["data"] = fields
        elif body is not None and not isinstance(body, NotGiven):
            if body_kind == "form":
                # `application/x-www-form-urlencoded`, which the spec asked for. Sending JSON
                # instead is a request the server rejects, and it is what happened to all 62 of
                # Twilio's write operations before this branch existed.
                #
                # Encoded here and passed as `content` rather than handed to httpx as `data`,
                # for one reason: `data={}` makes httpx send no body *and no content type*, so a
                # POST whose form fields are all optional and all unset arrived at the server as
                # a bodyless request it could not classify. PHP, Java, and .NET all set the
                # header in that case; Python did not, and a generated test caught the
                # disagreement. Encoding explicitly also makes the repeated-key rule this
                # project documents ours rather than httpx's.
                kwargs["content"] = urlencode(_form_fields(prune_body(body)), doseq=True)
                headers = dict(kwargs["headers"])
                headers.setdefault("content-type", "application/x-www-form-urlencoded")
                kwargs["headers"] = headers
            else:
                kwargs["json"] = prune_body(body)
        return client.build_request(**kwargs)


def _split_multipart(body: object) -> tuple[dict[str, object], dict[str, object]]:
    """Split a body into file parts and ordinary form fields.

    `bytes` is a file, everything else is a field. That test is the whole rule, and it lives
    here rather than in the target because "which field is a file" is one decision — the
    TypeScript runtime makes the same one against `Blob`.

    A `(name, content)` tuple rather than bare bytes, so the part carries a filename: a server
    matching on `filename=` sees nothing without it, and httpx omits the parameter for bare
    bytes. The field name is the filename, which is the best available guess — the spec carries
    none, and a caller who needs a specific one can pass the tuple themselves.
    """
    if not isinstance(body, dict):
        return {}, {}
    files: dict[str, object] = {}
    fields: dict[str, object] = {}
    for key, value in body.items():
        if value is None:
            continue
        if isinstance(value, bytes):
            files[key] = (key, value)
        elif isinstance(value, tuple):
            # Already a `(filename, content)` pair, httpx's own shape — passed through so a
            # caller can name the part.
            files[key] = value
        elif isinstance(value, (dict, list)):
            fields[key] = json.dumps(value)
        elif isinstance(value, bool):
            fields[key] = "true" if value else "false"
        else:
            fields[key] = value
    return files, fields


def _form_fields(body: object) -> dict[str, object]:
    """Flatten a body into `application/x-www-form-urlencoded` fields.

    A list becomes a repeated key, which is what every form-encoded API this project
    has seen expects; `key[]=` is a PHP convention and `key=a,b` is a third. A nested
    object is JSON-encoded, matching how the multipart path handles a structured field
    — form encoding has no canonical nesting, and inventing one would send something no
    server asked for.

    `None` is dropped rather than sent as the string `"None"`, which is the same rule
    the query encoder follows and the same bug it once had.
    """
    if not isinstance(body, dict):
        return {}
    out: dict[str, object] = {}
    for key, value in body.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            out[key] = [
                json.dumps(item) if isinstance(item, (dict, list)) else item
                for item in value
                if item is not None
            ]
        elif isinstance(value, dict):
            out[key] = json.dumps(value)
        elif isinstance(value, bool):
            # `str(True)` is `"True"`, which no server reads as true.
            out[key] = "true" if value else "false"
        else:
            out[key] = value
    return out


class BaseClient(_ClientBase):
    """The synchronous client generated resources call into."""

    def __init__(
        self,
        *,
        base_url: str,
        auth: Auth,
        timeout: float | None = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        user_agent: str | None = None,
        idempotency_header: str = DEFAULT_IDEMPOTENCY_HEADER,
        http_client: httpx.Client | None = None,
    ) -> None:
        super().__init__(
            base_url=base_url,
            auth=auth,
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            user_agent=user_agent,
            idempotency_header=idempotency_header,
        )
        # An injected client is not owned, so it is never closed by us — closing a client the caller
        # shares across SDKs would break the others.
        self._owns_client = http_client is None
        self._client = http_client or httpx.Client(
            timeout=timeout, auth=self._httpx_auth(), follow_redirects=True
        )

    def __enter__(self) -> BaseClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def request(
        self,
        *,
        method: HttpMethod,
        path: str,
        query: Mapping[str, QueryValue] | None = None,
        body: object = None,
        files: object = None,
        headers: Mapping[str, object] | None = None,
        options: RequestOptions | None = None,
        stream: bool = False,
        body_kind: str = "json",
    ) -> httpx.Response:
        """Send a request, retrying idempotent failures.

        Returns the raw response; decoding is the caller's decision, because a JSON body, a text
        body, and a byte stream want different handling and the generated method knows which it is.
        """
        attempts = self._retries_for(options)
        last_error: Exception | None = None
        # A 401 buys one forced token refresh and one retry — never more. Expiry arithmetic is
        # necessary but not sufficient (clocks disagree, servers revoke early), and retrying more
        # than once would turn a genuinely revoked credential into a loop.
        auth_refreshed = False
        attempt = -1

        while attempt < attempts:
            attempt += 1
            oauth_token = None
            if self._auth.kind == "oauth2" and isinstance(self._auth.source, TokenSource):
                oauth_token = self._auth.source.token()
            request = self._build(
                self._client,
                method=method,
                path=path,
                query=query,
                body=body,
                files=files,
                headers=headers,
                options=options,
                oauth_token=oauth_token,
                body_kind=body_kind,
            )
            try:
                response = self._client.send(request, stream=stream)
            except httpx.TimeoutException as error:
                last_error = APIConnectionTimeoutError(f"Request to {path} timed out")
                last_error.__cause__ = error
            except httpx.HTTPError as error:
                last_error = APIConnectionError(f"Could not reach {self._base_url}: {error}")
                last_error.__cause__ = error
            else:
                if response.status_code < 400:
                    return response
                if (
                    response.status_code == 401
                    and not auth_refreshed
                    and self._auth.kind == "oauth2"
                    and isinstance(self._auth.source, TokenSource)
                ):
                    auth_refreshed = True
                    response.close()
                    # Retried immediately and without consuming the retry budget: the failure was a
                    # stale token, not a busy server, so backing off would only add latency.
                    self._auth.source.force_refresh()
                    attempt -= 1
                    continue
                if (
                    response.status_code in _RETRY_STATUSES
                    and attempt < attempts
                    and self._replayable(method, options)
                ):
                    delay = _retry_delay(attempt + 1, response)
                    # A streamed error response holds the connection open until it is read.
                    response.close()
                    time.sleep(delay)
                    continue
                if stream:
                    response.read()
                _raise_for_status(response)

            if attempt < attempts and self._replayable(method, options):
                time.sleep(_retry_delay(attempt + 1, None))
            elif attempt < attempts:
                break

        # Unreachable unless the loop body changes: every path either returns, raises, or records
        # `last_error`. Written as a raise rather than an assert because `python -O` strips asserts,
        # and falling off the end of a function annotated to return a response would be worse.
        raise (
            last_error
            if last_error is not None
            else APIConnectionError(f"Request to {path} failed with no recorded error")
        )

    def request_json(self, **kwargs: Any) -> object:
        response = self.request(**kwargs)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise APIError(
                "Response was not valid JSON",
                status=response.status_code,
                body=response.text[:2048],
                request_id=_request_id(response),
                response=response,
            ) from error

    def request_text(self, **kwargs: Any) -> str:
        return self.request(**kwargs).text

    def request_bytes(self, **kwargs: Any) -> bytes:
        return self.request(**kwargs).content

    def request_none(self, **kwargs: Any) -> None:
        self.request(**kwargs).close()

    def request_lines(self, **kwargs: Any) -> Iterator[str]:
        """Stream a response line by line, closing it even if the caller stops early."""
        response = self.request(stream=True, **kwargs)
        try:
            yield from response.iter_lines()
        finally:
            response.close()


class AsyncBaseClient(_ClientBase):
    """The asynchronous client. Mirrors :class:`BaseClient` exactly."""

    def __init__(
        self,
        *,
        base_url: str,
        auth: Auth,
        timeout: float | None = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        user_agent: str | None = None,
        idempotency_header: str = DEFAULT_IDEMPOTENCY_HEADER,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(
            base_url=base_url,
            auth=auth,
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            user_agent=user_agent,
            idempotency_header=idempotency_header,
        )
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(
            timeout=timeout, auth=self._httpx_auth(), follow_redirects=True
        )

    async def __aenter__(self) -> AsyncBaseClient:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def request(
        self,
        *,
        method: HttpMethod,
        path: str,
        query: Mapping[str, QueryValue] | None = None,
        body: object = None,
        files: object = None,
        headers: Mapping[str, object] | None = None,
        options: RequestOptions | None = None,
        stream: bool = False,
        body_kind: str = "json",
    ) -> httpx.Response:
        import anyio

        attempts = self._retries_for(options)
        last_error: Exception | None = None
        # Mirrors the sync client exactly; see the comment there.
        auth_refreshed = False
        attempt = -1

        while attempt < attempts:
            attempt += 1
            oauth_token = None
            if self._auth.kind == "oauth2" and isinstance(self._auth.source, AsyncTokenSource):
                oauth_token = await self._auth.source.token()
            request = self._build(
                self._client,
                method=method,
                path=path,
                query=query,
                body=body,
                files=files,
                headers=headers,
                options=options,
                oauth_token=oauth_token,
                body_kind=body_kind,
            )
            try:
                response = await self._client.send(request, stream=stream)
            except httpx.TimeoutException as error:
                last_error = APIConnectionTimeoutError(f"Request to {path} timed out")
                last_error.__cause__ = error
            except httpx.HTTPError as error:
                last_error = APIConnectionError(f"Could not reach {self._base_url}: {error}")
                last_error.__cause__ = error
            else:
                if response.status_code < 400:
                    return response
                if (
                    response.status_code == 401
                    and not auth_refreshed
                    and self._auth.kind == "oauth2"
                    and isinstance(self._auth.source, AsyncTokenSource)
                ):
                    auth_refreshed = True
                    await response.aclose()
                    await self._auth.source.force_refresh()
                    attempt -= 1
                    continue
                if (
                    response.status_code in _RETRY_STATUSES
                    and attempt < attempts
                    and self._replayable(method, options)
                ):
                    delay = _retry_delay(attempt + 1, response)
                    await response.aclose()
                    await anyio.sleep(delay)
                    continue
                if stream:
                    await response.aread()
                _raise_for_status(response)

            if attempt < attempts and self._replayable(method, options):
                await anyio.sleep(_retry_delay(attempt + 1, None))
            elif attempt < attempts:
                break

        # Unreachable unless the loop body changes: every path either returns, raises, or records
        # `last_error`. Written as a raise rather than an assert because `python -O` strips asserts,
        # and falling off the end of a function annotated to return a response would be worse.
        raise (
            last_error
            if last_error is not None
            else APIConnectionError(f"Request to {path} failed with no recorded error")
        )

    async def request_json(self, **kwargs: Any) -> object:
        response = await self.request(**kwargs)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise APIError(
                "Response was not valid JSON",
                status=response.status_code,
                body=response.text[:2048],
                request_id=_request_id(response),
                response=response,
            ) from error

    async def request_text(self, **kwargs: Any) -> str:
        return (await self.request(**kwargs)).text

    async def request_bytes(self, **kwargs: Any) -> bytes:
        return (await self.request(**kwargs)).content

    async def request_none(self, **kwargs: Any) -> None:
        await (await self.request(**kwargs)).aclose()

    async def request_lines(self, **kwargs: Any) -> AsyncIterator[str]:
        response = await self.request(stream=True, **kwargs)
        try:
            async for line in response.aiter_lines():
                yield line
        finally:
            await response.aclose()
