"""Types shared across the runtime.

Hand-written, and vendored into every generated SDK as `_core/`. Nothing here is generated, so
this is where care is affordable (AGENTS.md, "Quality bar").
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal, TypeAlias, Union
from urllib.parse import quote

from pydantic import BaseModel

if TYPE_CHECKING:
    from collections.abc import Mapping

__all__ = [
    "NOT_GIVEN",
    "Headers",
    "HttpMethod",
    "NotGiven",
    "QueryValue",
    "RequestOptions",
    "encode_path",
    "given",
]

HttpMethod: TypeAlias = Literal["get", "post", "put", "patch", "delete", "head", "options"]


class NotGiven:
    """A sentinel distinguishing "argument omitted" from "argument passed as ``None``".

    Python has no equivalent of TypeScript's distinction between a missing property and one set to
    ``undefined``, but APIs routinely need it: ``PATCH {"description": null}`` clears a field, while
    omitting the key leaves it untouched. A default of ``None`` collapses those into one call, and
    the caller loses the ability to express the first.

    ``NotGiven`` is the convention the SDKs people like use (OpenAI, Anthropic, and Stripe's newer
    clients all carry a sentinel of this shape), so it needs no explanation to a Python developer.

    Falsy, so ``if value:`` behaves as a reader expects, and with a ``repr`` that reads as intended
    in a traceback rather than as ``<NotGiven object at 0x…>``.
    """

    def __bool__(self) -> Literal[False]:
        return False

    def __repr__(self) -> str:
        return "NOT_GIVEN"


NOT_GIVEN = NotGiven()

# `object` rather than `Any`: callers of the runtime pass values whose types we do not know, and
# `Any` would silently switch off `mypy --strict` for every expression it touches. `object` forces
# the runtime itself to narrow, which is where the narrowing belongs.
QueryValue: TypeAlias = object
Headers: TypeAlias = Union["Mapping[str, str | None]", None]


def given(value: object) -> bool:
    """Whether an argument was actually supplied.

    A function rather than ``value is not NOT_GIVEN`` at each site, because the sentinel comparison
    is easy to write as ``!=`` by accident, and ``NotGiven`` deliberately has no ``__eq__``.
    """
    return not isinstance(value, NotGiven)


class RequestOptions:
    """Per-call overrides.

    A class rather than a ``TypedDict`` because it is constructed by callers as
    ``RequestOptions(timeout=30)`` and passed positionally through the client hierarchy; keyword
    completion on a class is what an editor can actually offer.
    """

    __slots__ = ("extra_headers", "extra_query", "idempotency_key", "max_retries", "timeout")

    def __init__(
        self,
        *,
        timeout: float | NotGiven | None = NOT_GIVEN,
        max_retries: int | NotGiven = NOT_GIVEN,
        extra_headers: Mapping[str, str] | None = None,
        extra_query: Mapping[str, QueryValue] | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        self.timeout = timeout
        self.max_retries = max_retries
        self.extra_headers = extra_headers
        self.extra_query = extra_query
        # Makes a POST or PATCH safe to retry. Without one those methods are not retried, because
        # deduplication has to happen on the server — a client cannot make a replay safe by itself.
        self.idempotency_key = idempotency_key

    def __repr__(self) -> str:
        parts: list[str] = []
        if given(self.timeout):
            parts.append(f"timeout={self.timeout!r}")
        if given(self.max_retries):
            parts.append(f"max_retries={self.max_retries!r}")
        if self.extra_headers is not None:
            parts.append(f"extra_headers={self.extra_headers!r}")
        if self.extra_query is not None:
            parts.append(f"extra_query={self.extra_query!r}")
        return f"RequestOptions({', '.join(parts)})"


def _flatten_query_value(key: str, value: object, into: list[tuple[str, str]]) -> None:
    """Serialise one query value, matching the TypeScript runtime's rules exactly.

    Conformance tests assert both runtimes put the same bytes on the wire, so the two
    implementations of this are kept deliberately in step:

    - ``None`` and omitted values are dropped rather than sent as empty.
    - A mapping becomes ``key[inner]=value`` (OpenAPI ``deepObject``), which is how Stripe's range
      filters (``created[gte]=…``) are expressed.
    - A sequence repeats the key, which is the form every server we have tested accepts.
    - ``bool`` becomes ``true``/``false``, not Python's ``True``/``False``. This one is a real bug
      when missed: ``?active=True`` is not what any API means.
    """
    if value is None or isinstance(value, NotGiven):
        return
    if isinstance(value, bool):
        into.append((key, "true" if value else "false"))
        return
    if isinstance(value, (str, int, float)):
        into.append((key, str(value)))
        return
    if isinstance(value, dict):
        for inner_key, inner in value.items():
            _flatten_query_value(f"{key}[{inner_key}]", inner, into)
        return
    if isinstance(value, (list, tuple, set, frozenset)):
        for item in value:
            _flatten_query_value(key, item, into)
        return
    into.append((key, str(value)))


def build_query(params: Mapping[str, QueryValue] | None) -> list[tuple[str, str]]:
    """Flatten a parameter mapping into ordered query pairs.

    A list of pairs rather than a dict, because repeated keys are how arrays are expressed and a
    dict cannot hold them.
    """
    if params is None:
        return []
    pairs: list[tuple[str, str]] = []
    for key, value in params.items():
        _flatten_query_value(key, value, pairs)
    return pairs


def compact_headers(headers: Mapping[str, object] | None) -> dict[str, str]:
    """Drop absent headers and stringify the rest.

    Absent means ``None`` or ``NOT_GIVEN``. Sending a header with an empty value is not the same as
    not sending it, and some gateways reject the former.
    """
    if headers is None:
        return {}
    out: dict[str, str] = {}
    for key, value in headers.items():
        if value is None or isinstance(value, NotGiven):
            continue
        out[key] = "true" if value is True else "false" if value is False else str(value)
    return out


def prune_body(value: Any, *, json_mode: bool = True) -> Any:
    """Recursively drop ``NOT_GIVEN`` from a request body.

    Applied to bodies rather than filtering at each call site: a generated method assembles its body
    from optional keyword arguments, and every one of them defaults to the sentinel. Without this
    every optional field would be serialised as the string ``"NOT_GIVEN"``.

    ``None`` is deliberately **kept** — that is the whole reason the sentinel exists (see
    :class:`NotGiven`).
    """
    if isinstance(value, NotGiven):
        return None
    if isinstance(value, BaseModel):
        # A generated request model is a pydantic model, and httpx serialises with the *stdlib* JSON
        # encoder — which cannot serialise one. So passing a model as a request body raised
        # `TypeError: Object of type MemberInvitedEvent is not JSON serializable` at runtime, for
        # every operation whose body is a named schema. Nothing caught it because the conformance
        # driver passes plain dicts; a generated per-operation test, which constructs the declared
        # model exactly as a user would, found it on its first run (SPEC.md §3.11).
        #
        # `by_alias` because the wire name lives on the field's alias — without it a renamed
        # field would be sent under its Python name. `exclude_unset` because a field the
        # caller never touched must be *absent*, while one they set to `None` must be `null`:
        # that distinction is why `NotGiven` exists, and `exclude_none` would collapse it.
        # `mode="json"` for a JSON or form body, `mode="python"` for multipart.
        #
        # The distinction is `bytes`: JSON mode stringifies it, which is right for a JSON body
        # and destroys a file upload — the bytes reached the multipart splitter as a `str`, so
        # no file part was produced and httpx sent a plain form with no boundary. A generated
        # test caught it.
        mode = "json" if json_mode else "python"
        dumped = value.model_dump(mode=mode, by_alias=True, exclude_unset=True)
        return prune_body(dumped, json_mode=json_mode)
    if isinstance(value, dict):
        return {
            k: prune_body(v, json_mode=json_mode)
            for k, v in value.items()
            if not isinstance(v, NotGiven)
        }
    if isinstance(value, (list, tuple)):
        return [prune_body(item, json_mode=json_mode) for item in value]
    return value


def encode_path(value: object) -> str:
    """Percent-encode a value for use as a single path segment.

    ``safe=""`` is the whole point: the default leaves ``/`` alone, so an id containing a slash
    would silently address a different endpoint. That is a correctness bug and arguably a security
    one, so it lives here — reviewed once — rather than being spelled out at every call site in
    generated code. Generated paths read ``f"/orgs/{encode_path(org_id)}/members"``, which is both
    shorter than inlining ``quote(str(x), safe="")`` and inside the line limit.
    """
    return quote(str(value), safe="")


def is_sequence_of_pairs(value: object) -> bool:
    """Whether a value is already a list of query pairs, for pass-through."""
    if not isinstance(value, (list, tuple)):
        return False
    return all(isinstance(item, tuple) and len(item) == 2 for item in value)
