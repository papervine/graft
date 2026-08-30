"""Unit tests for the hand-written runtime.

No generated code is involved: the runtime is the quality ceiling for every Python SDK graft
produces, so it is tested on its own first (SPEC.md build order, M3 before M4).

Requests go through `httpx.MockTransport`, which exercises the real request-building, retry, and
decode paths rather than a stand-in for them.
"""

from __future__ import annotations

import httpx
import pytest

from graft_runtime import (
    NOT_GIVEN,
    APIConnectionTimeoutError,
    AsyncBaseClient,
    Auth,
    AuthenticationError,
    BaseClient,
    NotFoundError,
    NotGiven,
    Page,
    Paginator,
    RateLimitError,
    RequestOptions,
    advance_cursor,
    advance_offset,
    build_query,
    compact_headers,
    prune_body,
)


def client_with(handler: object, **kwargs: object) -> BaseClient:
    transport = httpx.MockTransport(handler)  # type: ignore[arg-type]
    return BaseClient(
        base_url="https://api.example.com",
        auth=Auth("bearer", token="tok_123"),
        max_retries=0,
        http_client=httpx.Client(transport=transport),
        **kwargs,  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------------
# Query serialisation
# ---------------------------------------------------------------------------


class TestQuery:
    def test_drops_absent_values(self) -> None:
        assert build_query({"a": 1, "b": None, "c": NOT_GIVEN}) == [("a", "1")]

    def test_booleans_are_lowercase(self) -> None:
        # `?active=True` is not what any API means. This was a real bug class in the TS runtime.
        assert build_query({"active": True, "archived": False}) == [
            ("active", "true"),
            ("archived", "false"),
        ]

    def test_arrays_repeat_the_key(self) -> None:
        assert build_query({"id": ["a", "b"]}) == [("id", "a"), ("id", "b")]

    def test_deep_objects_use_bracket_syntax(self) -> None:
        # Stripe's range filters: `created[gte]=1&created[lte]=2`.
        assert build_query({"created": {"gte": 1, "lte": 2}}) == [
            ("created[gte]", "1"),
            ("created[lte]", "2"),
        ]

    def test_nested_arrays_inside_objects(self) -> None:
        assert build_query({"f": {"ids": [1, 2]}}) == [("f[ids]", "1"), ("f[ids]", "2")]

    def test_zero_and_empty_string_survive(self) -> None:
        # A falsy-check instead of a None-check would drop both, and `?limit=0` is meaningful.
        assert build_query({"limit": 0, "q": ""}) == [("limit", "0"), ("q", "")]


class TestHeaders:
    def test_drops_absent(self) -> None:
        assert compact_headers({"A": "1", "B": None, "C": NOT_GIVEN}) == {"A": "1"}

    def test_booleans_are_wire_shaped(self) -> None:
        assert compact_headers({"X-Flag": True}) == {"X-Flag": "true"}


class TestPruneBody:
    def test_removes_sentinel_keeps_none(self) -> None:
        # The distinction the sentinel exists for: `None` clears a field, absent leaves it alone.
        assert prune_body({"a": 1, "b": NOT_GIVEN, "c": None}) == {"a": 1, "c": None}

    def test_recurses(self) -> None:
        assert prune_body({"o": {"x": NOT_GIVEN, "y": 2}, "l": [{"z": NOT_GIVEN}]}) == {
            "o": {"y": 2},
            "l": [{}],
        }


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------


class TestRequests:
    def test_sends_bearer_auth_and_parses_json(self) -> None:
        seen: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["auth"] = request.headers["authorization"]
            seen["url"] = str(request.url)
            return httpx.Response(200, json={"ok": True})

        result = client_with(handler).request_json(method="get", path="/widgets")
        assert result == {"ok": True}
        assert seen["auth"] == "Bearer tok_123"
        assert seen["url"] == "https://api.example.com/widgets"

    def test_api_key_in_query(self) -> None:
        seen: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(200, json={})

        client = BaseClient(
            base_url="https://api.example.com",
            auth=Auth("api_key", token="k", wire_name="api_key", location="query"),
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        client.request_json(method="get", path="/x")
        assert "api_key=k" in seen["url"]

    def test_basic_auth(self) -> None:
        seen: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["auth"] = request.headers.get("authorization", "")
            return httpx.Response(200, json={})

        client = BaseClient(
            base_url="https://api.example.com",
            auth=Auth("basic", username="u", password="p"),
            http_client=httpx.Client(
                transport=httpx.MockTransport(handler), auth=httpx.BasicAuth("u", "p")
            ),
        )
        client.request_json(method="get", path="/x")
        assert seen["auth"].startswith("Basic ")

    def test_204_decodes_to_none(self) -> None:
        result = client_with(lambda _r: httpx.Response(204)).request_json(
            method="delete", path="/widgets/1"
        )
        assert result is None

    def test_body_omits_sentinels(self) -> None:
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json={})

        client_with(handler).request_json(
            method="post", path="/widgets", body={"name": "x", "note": NOT_GIVEN, "tag": None}
        )
        assert seen["body"] == {"name": "x", "tag": None}

    def test_per_call_timeout_reaches_the_request(self) -> None:
        # A regression guard: the sync client once computed this value and never passed it on, so
        # `RequestOptions(timeout=...)` was silently ignored. Caught by a linter, not by a test,
        # which is why the test exists now.
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["timeout"] = request.extensions.get("timeout")
            return httpx.Response(200, json={})

        client_with(handler).request_json(
            method="get", path="/x", options=RequestOptions(timeout=7.0)
        )
        assert seen["timeout"] == {"connect": 7.0, "pool": 7.0, "read": 7.0, "write": 7.0}


class TestErrors:
    @pytest.mark.parametrize(
        ("status", "expected"),
        [(401, AuthenticationError), (404, NotFoundError), (429, RateLimitError)],
    )
    def test_status_maps_to_class(self, status: int, expected: type[Exception]) -> None:
        with pytest.raises(expected):
            client_with(lambda _r: httpx.Response(status, json={"message": "no"})).request_json(
                method="get", path="/x"
            )

    def test_message_and_request_id_are_surfaced(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                404, json={"message": "Widget not found"}, headers={"x-request-id": "req_9"}
            )

        with pytest.raises(NotFoundError) as caught:
            client_with(handler).request_json(method="get", path="/x")
        assert caught.value.message == "Widget not found"
        assert caught.value.request_id == "req_9"
        assert caught.value.status == 404

    def test_nested_error_message(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, json={"error": {"message": "bad field"}})

        with pytest.raises(Exception) as caught:
            client_with(handler).request_json(method="get", path="/x")
        assert "bad field" in str(caught.value)

    def test_non_json_error_body_does_not_mask_the_status(self) -> None:
        # An HTML error page from a gateway must still arrive as a 502, not a JSONDecodeError.
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(502, text="<html>bad gateway</html>")

        with pytest.raises(Exception) as caught:
            client_with(handler).request_json(method="get", path="/x")
        assert "502" in str(caught.value)

    def test_auth_repr_never_leaks_the_token(self) -> None:
        assert "tok_123" not in repr(Auth("bearer", token="tok_123"))


class TestRetries:
    def test_retries_500_then_succeeds(self) -> None:
        calls = {"n": 0}

        def handler(_request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] < 3:
                return httpx.Response(500, json={})
            return httpx.Response(200, json={"ok": True})

        client = BaseClient(
            base_url="https://api.example.com",
            auth=Auth("none"),
            max_retries=3,
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        assert client.request_json(method="get", path="/x") == {"ok": True}
        assert calls["n"] == 3

    def test_does_not_retry_400(self) -> None:
        calls = {"n": 0}

        def handler(_request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(400, json={})

        client = BaseClient(
            base_url="https://api.example.com",
            auth=Auth("none"),
            max_retries=3,
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(Exception):
            client.request_json(method="get", path="/x")
        # The request was understood and rejected; resending it is pure load.
        assert calls["n"] == 1

    def test_timeout_becomes_a_typed_error(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("too slow")

        client = BaseClient(
            base_url="https://api.example.com",
            auth=Auth("none"),
            max_retries=0,
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(APIConnectionTimeoutError):
            client.request_json(method="get", path="/x")


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


class TestPagination:
    def test_offset_walk_visits_each_item_once(self) -> None:
        # The TypeScript runtime once refetched page one forever because an explicit `offset=0`
        # overwrote the computed offset. This asserts the actual offset sequence, not just the count.
        offsets: list[object] = []
        data = [f"item{i}" for i in range(25)]

        def fetch(params: object) -> Page[str]:
            assert isinstance(params, dict)
            offsets.append(params.get("offset"))
            start = params.get("offset") or 0
            assert isinstance(start, int)
            limit = params.get("limit")
            assert isinstance(limit, int)
            window = data[start : start + limit]
            return Page(items=window, total=len(data), has_more=start + limit < len(data))

        paginator: Paginator[str] = Paginator(
            fetch, initial={"limit": 10, "offset": 0}, advance=advance_offset("limit", "offset")
        )
        assert list(paginator) == data
        assert offsets == [0, 10, 20]

    def test_cursor_walk_stops_when_the_cursor_runs_out(self) -> None:
        pages = [
            Page(items=["a"], next_cursor="c1"),
            Page(items=["b"], next_cursor="c2"),
            Page(items=["c"], next_cursor=None, has_more=False),
        ]
        seen: list[object] = []

        def fetch(params: object) -> Page[str]:
            assert isinstance(params, dict)
            seen.append(params.get("cursor"))
            return pages[len(seen) - 1]

        paginator: Paginator[str] = Paginator(fetch, advance=advance_cursor("cursor"))
        assert list(paginator) == ["a", "b", "c"]
        assert seen == [None, "c1", "c2"]

    def test_a_server_claiming_more_but_sending_no_cursor_terminates(self) -> None:
        # An API bug must not become a hung client.
        calls = {"n": 0}

        def fetch(_params: object) -> Page[str]:
            calls["n"] += 1
            return Page(items=["x"], has_more=True, next_cursor=None)

        paginator: Paginator[str] = Paginator(fetch, advance=advance_cursor("cursor"))
        assert list(paginator) == ["x"]
        assert calls["n"] == 1

    def test_nothing_is_fetched_before_iteration(self) -> None:
        calls = {"n": 0}

        def fetch(_params: object) -> Page[str]:
            calls["n"] += 1
            return Page(items=[], has_more=False)

        paginator: Paginator[str] = Paginator(fetch, advance=advance_cursor("cursor"))
        assert calls["n"] == 0
        list(paginator)
        assert calls["n"] == 1

    def test_page_is_directly_iterable_and_sized(self) -> None:
        page = Page(items=["a", "b"], total=2)
        assert list(page) == ["a", "b"]
        assert len(page) == 2
        assert bool(page) is True
        assert bool(Page(items=[])) is False


class TestNotGiven:
    def test_is_falsy_with_a_readable_repr(self) -> None:
        assert not NOT_GIVEN
        assert repr(NOT_GIVEN) == "NOT_GIVEN"
        assert isinstance(NOT_GIVEN, NotGiven)


# ---------------------------------------------------------------------------
# Async parity
# ---------------------------------------------------------------------------


class TestAsync:
    @pytest.mark.asyncio
    async def test_async_client_matches_sync_behaviour(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.headers["authorization"] == "Bearer tok"
            return httpx.Response(200, json={"ok": True})

        client = AsyncBaseClient(
            base_url="https://api.example.com",
            auth=Auth("bearer", token="tok"),
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        assert await client.request_json(method="get", path="/x") == {"ok": True}
        await client.aclose()

    @pytest.mark.asyncio
    async def test_async_errors_use_the_same_classes(self) -> None:
        client = AsyncBaseClient(
            base_url="https://api.example.com",
            auth=Auth("none"),
            max_retries=0,
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _r: httpx.Response(404, json={}))
            ),
        )
        with pytest.raises(NotFoundError):
            await client.request_json(method="get", path="/x")
        await client.aclose()
