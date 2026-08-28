"""Casing and identifier safety.

The IR stores every name as a lowercase token sequence (`["user", "id"]`) precisely so this
decision belongs to the target. Python wants `user_id` where TypeScript wants `userId`, and neither
target has to know about the other.
"""

from __future__ import annotations

import keyword
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

# Names that are not keywords but that shadow something a generated module relies on. Shadowing
# `list` inside a module that annotates `list[str]` is a genuine break, not a style problem.
_SHADOWED_BUILTINS = frozenset(
    {
        "bool",
        "bytes",
        "dict",
        "float",
        "frozenset",
        "id",
        "int",
        "list",
        "object",
        "set",
        "str",
        "tuple",
        "type",
    }
)

# Runtime exports a generated module imports. A model named `Page` would shadow the paginator in the
# same file, exactly as a TypeScript model named `RequestOptions` shadowed its runtime import.
RUNTIME_EXPORTS = frozenset(
    {
        "APIConnectionError",
        "APIConnectionTimeoutError",
        "APIError",
        "APIStatusError",
        "AsyncBaseClient",
        "AsyncPage",
        "AsyncPaginator",
        "Auth",
        "AuthenticationError",
        "BadRequestError",
        "BaseClient",
        "ConflictError",
        "InternalServerError",
        "NOT_GIVEN",
        "NotFoundError",
        "NotGiven",
        "OAuth2Config",
        "OAuth2Error",
        "TokenSource",
        "AsyncTokenSource",
        "Page",
        "PageInfo",
        "Paginator",
        "PermissionDeniedError",
        "RateLimitError",
        "RequestOptions",
        "SDKError",
        "StreamDecodeError",
        "UnprocessableEntityError",
    }
)

# Names a generated module imports from `typing`, `typing_extensions`, or `pydantic`. A spec-
# declared
# model called `Field` is not hypothetical: both Stripe and Twilio have one, and it shadowed
# `pydantic.Field` in the same module — so every subsequent `Field(..., alias=...)` was read as a
# reference to the model, and mypy reported 393 errors from that single collision.
TYPING_EXPORTS = frozenset(
    {
        "Any",
        "ConfigDict",
        "Field",
        "TypeAdapter",
        "AsyncIterator",
        "BaseModel",
        "ClassVar",
        "Iterator",
        "Literal",
        "Mapping",
        "NotRequired",
        "Optional",
        "Required",
        "Sequence",
        "TypeAlias",
        "TypedDict",
        "Union",
    }
)

RESERVED_TYPE_NAMES = RUNTIME_EXPORTS | TYPING_EXPORTS


def snake(tokens: Sequence[str]) -> str:
    """`["user", "id"]` → `user_id`."""
    parts = [token.lower() for token in tokens if token]
    return "_".join(parts) or "value"


def pascal(tokens: Sequence[str]) -> str:
    """`["user", "id"]` → `UserId`.

    Tokens are lowercase by IR contract, so this cannot preserve an initialism the author spelled
    as `API`. Where that matters — the client class — `service.displayName` carries the original
    casing and is used instead.
    """
    return "".join(token[:1].upper() + token[1:].lower() for token in tokens if token) or "Value"


def screaming(tokens: Sequence[str]) -> str:
    return snake(tokens).upper()


def safe_identifier(name: str) -> str:
    """Make a name usable as a local binding or a function parameter.

    Stricter than :func:`safe_attribute` because a bare `id` or `list` inside a function body really
    does shadow the builtin for the rest of that scope, and generated method bodies call `list()`
    and `str()`.

    A trailing underscore is Python's own convention for this (`from_`, `class_`, `id_`), so it
    reads as deliberate rather than generated-code damage. `str.isidentifier` decides what
    needs sanitising — a hand-written character class would miss the non-ASCII identifiers Python
    actually allows.
    """
    cleaned = "".join(char if char.isalnum() or char == "_" else "_" for char in name)
    if cleaned == "" or cleaned[0].isdigit():
        cleaned = f"_{cleaned}"
    if not cleaned.isidentifier():
        cleaned = "".join(char for char in cleaned if char.isalnum() or char == "_") or "value"
    if keyword.iskeyword(cleaned) or keyword.issoftkeyword(cleaned):
        return f"{cleaned}_"
    if cleaned in _SHADOWED_BUILTINS:
        return f"{cleaned}_"
    return cleaned


# Builtins the emitter itself writes as annotations. A *class attribute* with one of these names
# shadows it for every annotation later in the same class body: Stripe's `NotificationEventData` has
# a field called `object`, and `object: X` made the next `other: object` a reference to that field.
#
# Deliberately not "all builtins". `id` and `type` are never emitted as annotations and are two of
# the most common field names in real APIs, so suffixing them would mark almost every model in
# almost
# every SDK as machine-made.
ANNOTATION_BUILTINS = frozenset({"bool", "bytes", "dict", "float", "int", "list", "object", "str"})

# Methods `pydantic.BaseModel` itself defines. A read model with a field named `validate` — GitHub
# has one — is not just shadowing something cosmetic: pydantic reports it as a type conflict with
# the
# inherited method, and on older pydantic it would silently break validation for that model.
#
# Only the non-underscore, non-`model_` names, because pydantic v2 deliberately moved its own API
# behind the `model_` prefix precisely so that field names stay available.
PYDANTIC_MEMBERS = frozenset(
    {
        "construct",
        "copy",
        "dict",
        "from_orm",
        "json",
        "parse_file",
        "parse_obj",
        "parse_raw",
        "schema",
        "schema_json",
        "update_forward_refs",
        "validate",
    }
)


def safe_attribute(name: str) -> str:
    """Make a name usable as a model field or a resource attribute.

    Shadowing a builtin is mostly harmless here for the same reason it is harmless for a method: the
    name is reached through an instance, so `member.id` cannot collide with the `id()` function. And
    `id` is overwhelmingly the most common field name in real APIs — suffixing it to `id_` would put
    the tell-tale mark of a generator on almost every model in almost every SDK. OpenAI's Python SDK
    exposes `completion.id`; so does Stripe's.

    The exceptions are keywords, which are unavoidable (`self.from` is a syntax error, and `from_`
    is idiomatic enough to read as deliberate), and the annotation builtins above.
    """
    cleaned = "".join(char if char.isalnum() or char == "_" else "_" for char in name)
    if cleaned == "" or cleaned[0].isdigit():
        cleaned = f"_{cleaned}"
    if keyword.iskeyword(cleaned) or cleaned in ANNOTATION_BUILTINS or cleaned in PYDANTIC_MEMBERS:
        return f"{cleaned}_"
    return cleaned


def unique_attribute(name: str, taken: set[str]) -> str:
    """An attribute name not already used in the same class.

    Two different wire names can sanitise to the same identifier — GitHub has a schema whose
    properties produce `_1` twice, and the second silently replaced the first, losing a field. The
    wire name survives on the `alias`, so disambiguating the Python name costs the caller nothing.
    """
    candidate = safe_attribute(name)
    if candidate not in taken:
        taken.add(candidate)
        return candidate
    index = 2
    while f"{candidate}_{index}" in taken:
        index += 1
    resolved = f"{candidate}_{index}"
    taken.add(resolved)
    return resolved


def safe_method_name(name: str) -> str:
    """Make a name usable as a method.

    Deliberately more permissive than :func:`safe_identifier`: a method name is looked up on an
    instance, so shadowing a builtin is harmless — `client.widgets.list()` is correct and
    `client.widgets.list_()` is the tell-tale sign of a generator that did not think about it.
    Only genuine keywords are suffixed: `def import(self)` is a syntax error, `def list(self)` is
    not.
    """
    cleaned = "".join(char if char.isalnum() or char == "_" else "_" for char in name)
    if cleaned == "" or cleaned[0].isdigit():
        cleaned = f"_{cleaned}"
    if keyword.iskeyword(cleaned):
        return f"{cleaned}_"
    return cleaned


def safe_type_name(name: str, taken: frozenset[str] | set[str]) -> str:
    """Make a name usable as a class, avoiding collisions with what the module needs.

    Suffixed with ``Model`` rather than a digit for the same reason the TypeScript target prefers
    ``RecordModel`` to ``Record2``: one reads as deliberate, the other as the generator giving up.
    """
    base = "".join(char if char.isalnum() or char == "_" else "_" for char in name)
    if base == "" or base[0].isdigit():
        base = f"Model{base}"
    if keyword.iskeyword(base):
        base = f"{base}Model"
    if base in taken:
        candidate = f"{base}Model"
        if candidate not in taken:
            return candidate
        index = 2
        while f"{base}Model{index}" in taken:
            index += 1
        return f"{base}Model{index}"
    return base


def snake_from_mixed(text: str) -> str:
    """`Api20100401Address` → `api20100401_address`.

    Resource ids come from the spec's own tags and are *not* normalised to tokens, so they arrive in
    whatever case the author used. Twilio's are PascalCase, which produced module files named
    `Api20100401Address.py` — PEP 8 requires lowercase module names, and a Python developer reading
    that directory would immediately know it was generated by something that does not write Python.
    """
    out: list[str] = []
    for index, char in enumerate(text):
        if char in "._- ":
            out.append("_")
            continue
        if char.isupper() and index > 0:
            previous = text[index - 1]
            following = text[index + 1] if index + 1 < len(text) else ""
            # A boundary is a lower/digit followed by an upper (`fooBar`), or the end of a run of
            # capitals before a lowercase (`HTTPServer` → `http_server`).
            if (
                previous.islower()
                or previous.isdigit()
                or (previous.isupper() and following.islower())
            ):
                out.append("_")
        out.append(char.lower())
    collapsed = "".join(out)
    while "__" in collapsed:
        collapsed = collapsed.replace("__", "_")
    return collapsed.strip("_")


def module_name(resource_id: str) -> str:
    """A module filename for a resource id.

    Resource ids arrive dotted (`orgs.invoices`); Python modules are flat inside a package, so the
    separator becomes an underscore rather than a directory. A nested package would mean an
    `__init__.py` per level for no gain, since callers reach sub-resources through the parent
    attribute (`client.orgs.invoices`) and never import the module directly.
    """
    return safe_identifier(snake_from_mixed(resource_id)) or "resource"
