"""OAuth2 tests for the Python runtime.

The token request is barely worth testing. These cover the three things around it that are easy to get
wrong and expensive when wrong (SPEC.md §3.1.6): single-flight refresh, proactive expiry, and retrying
a 401 exactly once.
"""

from __future__ import annotations

import contextlib
import threading
from typing import Any

import httpx
import pytest

from besdk_runtime import (
    AsyncBaseClient,
    AsyncTokenSource,
    Auth,
    BaseClient,
    OAuth2Config,
    OAuth2Error,
    TokenSource,
)

CLIENT_CREDENTIALS = OAuth2Config(
    flow="client_credentials",
    token_url="https://auth.test/token",
    client_id="id",
    client_secret="secret",
)


def token_transport(
    responses: list[dict[str, Any]], calls: list[httpx.Request]
) -> httpx.MockTransport:
    """A transport that answers the token endpoint, recording every request."""

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        index = min(len(calls) - 1, len(responses) - 1)
        entry = responses[index]
        return httpx.Response(entry.get("status", 200), json=entry["body"])

    return httpx.MockTransport(handler)


class TestTokenRequest:
    def test_sends_client_credentials_with_basic_auth(self) -> None:
        calls: list[httpx.Request] = []
        transport = token_transport(
            [{"body": {"access_token": "tok_1", "expires_in": 3600}}], calls
        )
        source = TokenSource(CLIENT_CREDENTIALS, httpx.Client(transport=transport))

        assert source.token() == "tok_1"
        body = calls[0].content.decode()
        assert "grant_type=client_credentials" in body
        # RFC 6749 requires servers to accept the header form, so it is the default.
        assert calls[0].headers["authorization"].startswith("Basic ")
        # The credentials must not also appear in the body.
        assert "client_secret" not in body

    def test_can_send_credentials_in_the_body(self) -> None:
        calls: list[httpx.Request] = []
        transport = token_transport([{"body": {"access_token": "t"}}], calls)
        config = OAuth2Config(
            flow="client_credentials",
            token_url="https://auth.test/token",
            client_id="id",
            client_secret="secret",
            client_auth="body",
        )
        TokenSource(config, httpx.Client(transport=transport)).token()
        assert "authorization" not in calls[0].headers
        assert "client_id=id" in calls[0].content.decode()

    def test_sends_scopes_space_separated(self) -> None:
        calls: list[httpx.Request] = []
        transport = token_transport([{"body": {"access_token": "t"}}], calls)
        config = OAuth2Config(
            flow="client_credentials",
            token_url="https://auth.test/token",
            client_id="id",
            client_secret="s",
            scopes=["read:widgets", "write:widgets"],
        )
        TokenSource(config, httpx.Client(transport=transport)).token()
        # Parsed rather than string-matched: form encoding turns a space into `+`.
        from urllib.parse import parse_qs

        parsed = parse_qs(calls[0].content.decode())
        assert parsed["scope"] == ["read:widgets write:widgets"]


class TestCachingAndExpiry:
    def test_reuses_a_valid_token(self) -> None:
        calls: list[httpx.Request] = []
        transport = token_transport([{"body": {"access_token": "tok", "expires_in": 3600}}], calls)
        source = TokenSource(CLIENT_CREDENTIALS, httpx.Client(transport=transport))
        for _ in range(3):
            source.token()
        assert len(calls) == 1

    def test_refreshes_before_the_token_actually_expires(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Refreshing only once a token has expired guarantees at least one failed request first.
        calls: list[httpx.Request] = []
        responses = [
            {"body": {"access_token": "tok_1", "expires_in": 60}},
            {"body": {"access_token": "tok_2", "expires_in": 60}},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(200, json=responses[min(len(calls) - 1, 1)]["body"])

        source = TokenSource(
            CLIENT_CREDENTIALS, httpx.Client(transport=httpx.MockTransport(handler))
        )
        clock = [1000.0]
        monkeypatch.setattr("besdk_runtime._oauth2.time.monotonic", lambda: clock[0])

        assert source.token() == "tok_1"
        # 35s in: still inside the 60s lifetime, but past the 30s safety margin.
        clock[0] += 35
        assert source.token() == "tok_2"
        assert len(calls) == 2

    def test_no_expires_in_means_long_lived(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls: list[httpx.Request] = []
        transport = token_transport([{"body": {"access_token": "tok"}}], calls)
        source = TokenSource(CLIENT_CREDENTIALS, httpx.Client(transport=transport))
        clock = [1000.0]
        monkeypatch.setattr("besdk_runtime._oauth2.time.monotonic", lambda: clock[0])
        source.token()
        clock[0] += 86_400
        source.token()
        # Nothing to expire against, so nothing to refresh.
        assert len(calls) == 1


class TestSingleFlight:
    def test_one_token_request_for_many_concurrent_threads(self) -> None:
        # Without this, the first thing a new SDK does under load is hammer the authorization server,
        # and the symptom is unexplained 429s from a host the caller never configured.
        calls: list[httpx.Request] = []
        gate = threading.Event()

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            gate.wait(timeout=5)
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})

        source = TokenSource(
            CLIENT_CREDENTIALS, httpx.Client(transport=httpx.MockTransport(handler))
        )
        tokens: list[str] = []
        threads = [
            threading.Thread(target=lambda: tokens.append(source.token())) for _ in range(10)
        ]
        for thread in threads:
            thread.start()
        gate.set()
        for thread in threads:
            thread.join(timeout=5)

        assert len(calls) == 1
        assert set(tokens) == {"tok"}

    def test_a_failed_refresh_does_not_poison_later_calls(self) -> None:
        state = {"failing": True}

        def handler(_request: httpx.Request) -> httpx.Response:
            if state["failing"]:
                return httpx.Response(503, json={"error": "temporarily_unavailable"})
            return httpx.Response(200, json={"access_token": "tok"})

        source = TokenSource(
            CLIENT_CREDENTIALS, httpx.Client(transport=httpx.MockTransport(handler))
        )
        with pytest.raises(OAuth2Error):
            source.token()
        state["failing"] = False
        assert source.token() == "tok"


class TestRefreshTokenFlow:
    def test_adopts_a_rotated_refresh_token(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A server that rotates refresh tokens invalidates the old one, so reusing it would fail on
        # the *second* refresh — a bug that only appears after a token lifetime has elapsed.
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            n = len(calls)
            return httpx.Response(
                200,
                json={"access_token": f"a_{n}", "refresh_token": f"r_{n}", "expires_in": 60},
            )

        config = OAuth2Config(
            flow="refresh_token", token_url="https://auth.test/token", refresh_token="r_0"
        )
        source = TokenSource(config, httpx.Client(transport=httpx.MockTransport(handler)))
        clock = [1000.0]
        monkeypatch.setattr("besdk_runtime._oauth2.time.monotonic", lambda: clock[0])

        assert source.token() == "a_1"
        assert "refresh_token=r_0" in calls[0].content.decode()
        clock[0] += 35
        assert source.token() == "a_2"
        assert "refresh_token=r_1" in calls[1].content.decode()


class TestFailures:
    def test_surfaces_the_server_error_code(self) -> None:
        calls: list[httpx.Request] = []
        transport = token_transport(
            [
                {
                    "status": 401,
                    "body": {"error": "invalid_client", "error_description": "bad secret"},
                }
            ],
            calls,
        )
        source = TokenSource(CLIENT_CREDENTIALS, httpx.Client(transport=transport))
        with pytest.raises(OAuth2Error) as caught:
            source.token()
        assert caught.value.code == "invalid_client"
        assert caught.value.status == 401
        assert caught.value.message == "bad secret"

    def test_never_retries_a_token_request(self) -> None:
        # A 400 from a token endpoint means the credentials are wrong. Retrying is pointless and
        # indistinguishable from a brute-force attempt.
        calls: list[httpx.Request] = []
        transport = token_transport([{"status": 400, "body": {"error": "invalid_grant"}}], calls)
        with pytest.raises(OAuth2Error):
            TokenSource(CLIENT_CREDENTIALS, httpx.Client(transport=transport)).token()
        assert len(calls) == 1

    def test_reports_a_missing_access_token(self) -> None:
        calls: list[httpx.Request] = []
        transport = token_transport([{"body": {"token_type": "Bearer"}}], calls)
        with pytest.raises(OAuth2Error, match="no access_token"):
            TokenSource(CLIENT_CREDENTIALS, httpx.Client(transport=transport)).token()


class TestClientIntegration:
    """A 401 from the API forces one refresh and one retry."""

    @staticmethod
    def combined(api_statuses: list[int]) -> tuple[httpx.MockTransport, list[str]]:
        log: list[str] = []
        counts = {"token": 0, "api": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if "/token" in request.url.path:
                counts["token"] += 1
                log.append(f"token:{counts['token']}")
                return httpx.Response(200, json={"access_token": f"tok_{counts['token']}"})
            index = counts["api"]
            counts["api"] += 1
            status = api_statuses[index] if index < len(api_statuses) else 200
            log.append(f"api:{status}")
            return httpx.Response(status, json={"ok": status == 200})

        return httpx.MockTransport(handler), log

    def test_forces_one_refresh_and_retries_once(self) -> None:
        transport, log = self.combined([401, 200])
        http_client = httpx.Client(transport=transport)
        source = TokenSource(CLIENT_CREDENTIALS, http_client)
        client = BaseClient(
            base_url="https://api.test",
            auth=Auth("oauth2", source=source),
            max_retries=-1,
            http_client=http_client,
        )
        assert client.request_json(method="get", path="/widgets") == {"ok": True}
        assert log == ["token:1", "api:401", "token:2", "api:200"]

    def test_gives_up_after_one_refresh(self) -> None:
        # A genuinely revoked credential must not become a loop against the authorization server.
        transport, log = self.combined([401, 401, 401])
        http_client = httpx.Client(transport=transport)
        source = TokenSource(CLIENT_CREDENTIALS, http_client)
        client = BaseClient(
            base_url="https://api.test",
            auth=Auth("oauth2", source=source),
            max_retries=-1,
            http_client=http_client,
        )
        with pytest.raises(Exception):
            client.request_json(method="get", path="/widgets")
        assert log.count("token:1") + log.count("token:2") == 2
        assert log.count("api:401") == 2

    def test_does_not_refresh_for_a_non_401(self) -> None:
        transport, log = self.combined([403])
        http_client = httpx.Client(transport=transport)
        source = TokenSource(CLIENT_CREDENTIALS, http_client)
        client = BaseClient(
            base_url="https://api.test",
            auth=Auth("oauth2", source=source),
            max_retries=-1,
            http_client=http_client,
        )
        with pytest.raises(Exception):
            client.request_json(method="get", path="/widgets")
        assert len([entry for entry in log if entry.startswith("token:")]) == 1


class TestAsync:
    @pytest.mark.asyncio
    async def test_async_single_flight(self) -> None:
        import asyncio

        calls: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            await asyncio.sleep(0.01)
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})

        source = AsyncTokenSource(
            CLIENT_CREDENTIALS, httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )
        tokens = await asyncio.gather(*[source.token() for _ in range(10)])
        assert len(calls) == 1
        assert set(tokens) == {"tok"}

    @pytest.mark.asyncio
    async def test_async_401_forces_one_refresh(self) -> None:
        log: list[str] = []
        counts = {"token": 0, "api": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if "/token" in request.url.path:
                counts["token"] += 1
                log.append(f"token:{counts['token']}")
                return httpx.Response(200, json={"access_token": f"tok_{counts['token']}"})
            counts["api"] += 1
            status = 401 if counts["api"] == 1 else 200
            log.append(f"api:{status}")
            return httpx.Response(status, json={"ok": status == 200})

        http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        source = AsyncTokenSource(CLIENT_CREDENTIALS, http_client)
        client = AsyncBaseClient(
            base_url="https://api.test",
            auth=Auth("oauth2", source=source),
            max_retries=-1,
            http_client=http_client,
        )
        assert await client.request_json(method="get", path="/widgets") == {"ok": True}
        assert log == ["token:1", "api:401", "token:2", "api:200"]
        await client.aclose()


class TestRetrySafety:
    """A POST must not be replayed without an idempotency key.

    The absence of this check was a bug rather than a missing feature: a `POST /charges` returning 503
    was sent three times, and whether the server processed the first one is unknowable from the client.
    """

    @staticmethod
    def attempts(method: str, options: Any = None) -> int:
        calls = {"n": 0}

        def handler(_request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(503, json={})

        client = BaseClient(
            base_url="https://api.test",
            auth=Auth("none"),
            max_retries=2,
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        # The request is expected to fail after exhausting whatever retries it was entitled to; the
        # attempt count is the thing under test.
        with contextlib.suppress(Exception):
            client.request(method=method, path="/things", options=options)  # type: ignore[arg-type]
        return calls["n"]

    @pytest.mark.parametrize("method", ["get", "head", "put", "delete", "options"])
    def test_retries_idempotent_methods(self, method: str) -> None:
        assert self.attempts(method) == 3

    @pytest.mark.parametrize("method", ["post", "patch"])
    def test_does_not_retry_post_or_patch_without_a_key(self, method: str) -> None:
        assert self.attempts(method) == 1

    def test_retries_post_with_a_key(self) -> None:
        from besdk_runtime import RequestOptions

        assert self.attempts("post", RequestOptions(idempotency_key="req_abc")) == 3

    def test_sends_the_key_on_every_attempt(self) -> None:
        # One key per logical request, never per attempt — the server has to recognise the replay.
        from besdk_runtime import RequestOptions

        seen: list[str] = []
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            seen.append(request.headers.get("idempotency-key", "(absent)"))
            if calls["n"] < 2:
                return httpx.Response(503, json={})
            return httpx.Response(200, json={"ok": True})

        client = BaseClient(
            base_url="https://api.test",
            auth=Auth("none"),
            max_retries=2,
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        client.request_json(
            method="post", path="/charges", options=RequestOptions(idempotency_key="key_1")
        )
        assert seen == ["key_1", "key_1"]

    def test_honours_a_configured_header_name(self) -> None:
        from besdk_runtime import RequestOptions

        seen: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(request.headers)
            return httpx.Response(200, json={})

        client = BaseClient(
            base_url="https://api.test",
            auth=Auth("none"),
            max_retries=0,
            idempotency_header="X-Idempotency-Token",
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        client.request_json(
            method="post", path="/charges", options=RequestOptions(idempotency_key="key_1")
        )
        assert seen["x-idempotency-token"] == "key_1"
