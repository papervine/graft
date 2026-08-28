"""The Python conformance driver.

Runs every shared scenario against the mock server using the *generated* SDK, and prints what it
observed as JSON on stdout. The runner compares that against the scenario expectations and against
the other languages' drivers.

Calls are written natively — `client.orgs.list_members("o1", limit=2)` — because the point is that
idiomatic code in each language produces identical wire behaviour. A data-driven driver dispatching on
operation names would prove nothing about idiom.

Usage: python python_driver.py <baseURL>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "sdks" / "kitchen-sink-python" / "src"))

from kitchen_sink import (  # noqa: E402
    BadRequestError,
    KitchenSink,
    NotFoundError,
    RequestOptions,
)
from pydantic import ValidationError  # noqa: E402


def client(scenario: str, max_retries: int = 0) -> KitchenSink:
    """A client pinned to one scenario, so the server knows which script to replay."""
    # An API key, not a bearer token: this spec declares only `X-Api-Key`, so there is no `token`
    # parameter on the generated client.
    return KitchenSink(
        base_url=BASE_URL,
        api_key="key_conformance",
        max_retries=max_retries if max_retries else 0,
        default_headers={"X-Scenario": scenario},
    )


def list_categories() -> dict[str, str]:
    categories = client("list_categories").categories.list()
    return {
        "count": str(len(categories)),
        "first_slug": str(categories[0].slug),
        "second_name": str(categories[1].name),
    }


def paginate_members() -> dict[str, str]:
    emails = [m.email for m in client("paginate_members").orgs.list_members("o1", limit=2)]
    return {"emails": ",".join(emails), "count": str(len(emails))}


def query_serialization() -> dict[str, str]:
    # `since` is deliberately omitted: an absent optional parameter must not reach the wire at all.
    results = client("query_serialization").search.query(q="sprocket", kind="member")
    return {"count": str(len(results))}


def path_escaping() -> dict[str, str]:
    pdf = client("path_escaping").orgs.invoices.download_pdf("a/b", "i1")
    return {"byte_length": str(len(pdf))}


def error_404() -> dict[str, str]:
    try:
        # Draining is required: the paginator is lazy, so the request happens on iteration.
        list(client("error_404").orgs.list_members("missing"))
    except NotFoundError as error:
        return {
            "error_kind": "not_found",
            "status": str(error.status),
            "message": str(error.message),
            "request_id": str(error.request_id),
        }
    except Exception as error:  # noqa: BLE001
        return {"error_kind": f"wrong:{type(error).__name__}"}
    return {"error_kind": "none"}


def retry_then_success() -> dict[str, str]:
    # An idempotency key, because a POST without one is no longer retried.
    receipt = client("retry_then_success", 2).events.publish(
        body={"type": "widget.created"},
        options=RequestOptions(idempotency_key="conformance_1"),
    )
    return {"accepted": str(receipt.accepted), "event_id": str(receipt.event_id)}


def no_retry_without_idempotency_key() -> dict[str, str]:
    try:
        client("no_retry_without_idempotency_key", 2).events.publish(
            body={"type": "widget.created"}
        )
    except Exception as error:  # noqa: BLE001
        status = getattr(error, "status", 0)
        return {"error_kind": "server_error" if status >= 500 else f"wrong:{type(error).__name__}"}
    return {"error_kind": "none"}


def no_retry_on_400() -> dict[str, str]:
    try:
        client("no_retry_on_400", 2).events.publish(body={"type": "widget.created"})
    except BadRequestError:
        return {"error_kind": "bad_request"}
    except Exception as error:  # noqa: BLE001
        return {"error_kind": f"wrong:{type(error).__name__}"}
    return {"error_kind": "none"}


def validation_catches_a_broken_contract() -> dict[str, str]:
    try:
        client("validation_catches_a_broken_contract").categories.list()
    except ValidationError as error:
        # pydantic reports a tuple location; rendered in the same `[index].field` form the other two
        # languages use so the comparison is about behaviour, not about each library's formatting.
        location = error.errors()[0]["loc"]
        path = ""
        for part in location:
            path += f"[{part}]" if isinstance(part, int) else (f".{part}" if path else str(part))
        return {"error_kind": "validation", "path": path}
    except Exception as error:  # noqa: BLE001
        return {"error_kind": f"wrong:{type(error).__name__}"}
    return {"error_kind": "none"}


def validation_on_a_paginated_response() -> dict[str, str]:
    try:
        list(client("validation_on_a_paginated_response").orgs.list_members("o1"))
    except ValidationError as error:
        location = error.errors()[0]["loc"]
        path = ""
        for part in location:
            path += f"[{part}]" if isinstance(part, int) else (f".{part}" if path else str(part))
        # pydantic reports the list index too; the field is what matters for the comparison.
        return {"error_kind": "validation", "path": path.split(".")[-1].split("]")[-1] or path}
    except Exception as error:  # noqa: BLE001
        return {"error_kind": f"wrong:{type(error).__name__}"}
    return {"error_kind": "none"}


def validation_allows_an_additive_field() -> dict[str, str]:
    categories = client("validation_allows_an_additive_field").categories.list()
    return {"count": str(len(categories)), "first_slug": str(categories[0].slug)}


def text_response() -> dict[str, str]:
    csv = client("text_response").reports.export_usage()
    lines = csv.rstrip("\n").split("\n")
    return {"text_starts_with": lines[0], "line_count": str(len(lines))}


SCENARIOS: dict[str, Callable[[], dict[str, str]]] = {
    "list_categories": list_categories,
    "paginate_members": paginate_members,
    "query_serialization": query_serialization,
    "path_escaping": path_escaping,
    "error_404": error_404,
    "retry_then_success": retry_then_success,
    "no_retry_without_idempotency_key": no_retry_without_idempotency_key,
    "no_retry_on_400": no_retry_on_400,
    "validation_catches_a_broken_contract": validation_catches_a_broken_contract,
    "validation_on_a_paginated_response": validation_on_a_paginated_response,
    "validation_allows_an_additive_field": validation_allows_an_additive_field,
    "text_response": text_response,
}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.stderr.write("usage: python_driver.py <baseURL>\n")
        raise SystemExit(2)
    BASE_URL = sys.argv[1]

    observed: dict[str, Any] = {}
    for name, run in SCENARIOS.items():
        try:
            observed[name] = run()
        except Exception as error:  # noqa: BLE001 -- a driver reports failures, never raises
            observed[name] = {"_error": f"{type(error).__name__}: {error}"}
    sys.stdout.write(json.dumps({"language": "python", "observed": observed}, indent=2))
