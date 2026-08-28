"""Mapping IR type references to Python annotations."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .naming import RESERVED_TYPE_NAMES, pascal, safe_type_name

if TYPE_CHECKING:
    from collections.abc import Mapping

# `format:` values that have a natural Python type. Deliberately conservative: a format we do not
# recognise stays `str`, because inventing a coercion the server did not promise is worse than
# handing the caller the string it actually sent.
_STRING_FORMATS: Mapping[str, str] = {
    "date-time": "datetime",
    "date": "date",
    "uuid": "UUID",
    "binary": "bytes",
    "decimal": "Decimal",
}

_FORMAT_IMPORTS: Mapping[str, tuple[str, str]] = {
    "datetime": ("datetime", "datetime"),
    "date": ("datetime", "date"),
    "UUID": ("uuid", "UUID"),
    "Decimal": ("decimal", "Decimal"),
}


class TypeMapper:
    """Resolves IR type ids to Python class names, and renders annotations.

    Names are assigned once, up front, so every module agrees on what a type is called and a
    reference emitted in one file matches the declaration in another.
    """

    def __init__(self, ir: Mapping[str, Any]) -> None:
        self._ir = ir
        self._by_id: dict[str, str] = {}
        self._id_for_name: dict[str, str] = {}
        # Seeded with everything a generated module imports, so a spec-declared model called `Page`
        # or `Literal` is renamed rather than silently shadowing what the file depends on.
        taken: set[str] = set(RESERVED_TYPE_NAMES)
        for named in ir.get("types", []):
            declared = safe_type_name(pascal(named["name"]["tokens"]), taken)
            taken.add(declared)
            self._by_id[named["id"]] = declared
            self._id_for_name[declared] = named["id"]
        self._types_by_id = {named["id"]: named for named in ir.get("types", [])}
        # Reset per module by `begin_scope`. A single accumulating set leaked `datetime` into every
        # module once any module needed it, which `ruff` then flagged as an unused import in all the
        # others — a real defect found by reading the output.
        self.needed_imports: set[tuple[str, str]] = set()

    def begin_scope(self) -> None:
        """Start collecting imports for a new module."""
        self.needed_imports = set()

    def declared_name(self, type_id: str) -> str:
        return self._by_id.get(type_id, "object")

    def id_for_name(self, name: str) -> str | None:
        return self._id_for_name.get(name)

    def definition(self, type_id: str) -> Mapping[str, Any] | None:
        return self._types_by_id.get(type_id)

    def render(self, ref: Mapping[str, Any] | None) -> str:
        """Render a type reference as a Python annotation.

        Returns `object`, never `Any`, for unknown data — `Any` silently switches off
        `mypy --strict` for every expression it touches, which is the gate that justifies the
        pipeline.
        """
        if ref is None:
            return "None"

        kind = ref.get("kind")

        if kind == "primitive":
            return self._primitive(ref)
        if kind == "named":
            return self.declared_name(ref["id"])
        if kind == "array":
            inner = self.render(ref.get("items"))
            # `list`, not `Sequence`: variance favours `Sequence` on a read model, but `list` is
            # what a caller sees in a repr and what every Python SDK returns.
            return f"list[{inner}]"
        if kind == "map":
            return f"dict[str, {self.render(ref.get('values'))}]"
        if kind == "nullable":
            # The one place presence and nullability meet: `nullable` is about the *value*, so it
            # renders `| None` here, while absence renders `NotRequired[...]` at the field.
            inner = self.render(ref.get("inner"))
            return inner if inner == "None" or inner.endswith("| None") else f"{inner} | None"
        if kind == "literal":
            return f"Literal[{ref['value']!r}]"
        if kind == "binary":
            return "bytes"
        if kind == "null":
            return "None"
        if kind == "union":
            return self._union(ref)
        if kind == "unknown":
            return "object"
        return "object"

    def _union(self, ref: Mapping[str, Any]) -> str:
        """Render a union, flattening duplicates.

        A `coercion: 'scalar'` union is not a domain union — it exists because the server is loose
        about scalar encoding (`oneOf: [string, integer]`). It still renders as a union here rather
        than being widened to `str`: Python callers can handle `int | str` directly, and widening
        would throw away the type information the spec did supply.
        """
        rendered: list[str] = []
        for variant in ref.get("variants", []):
            annotation = self.render(variant)
            if annotation not in rendered:
                rendered.append(annotation)
        if not rendered:
            return "object"
        if "object" in rendered:
            # A union containing unknown data collapses: `object | str` is just `object`, and
            # emitting the longer form invites a reader to think the narrowing means something.
            return "object"
        return " | ".join(rendered)

    def _primitive(self, ref: Mapping[str, Any]) -> str:
        name = ref.get("type")
        fmt = ref.get("format")
        if name == "string":
            mapped = _STRING_FORMATS.get(str(fmt)) if fmt else None
            if mapped is not None:
                self._note_import(mapped)
                return mapped
            return "str"
        if name == "integer":
            return "int"
        if name == "number":
            return "float"
        if name == "boolean":
            return "bool"
        if name == "null":
            return "None"
        return "object"

    def _note_import(self, rendered: str) -> None:
        pair = _FORMAT_IMPORTS.get(rendered)
        if pair is not None:
            self.needed_imports.add(pair)

    def nullable(self, annotation: str, *, is_nullable: bool) -> str:
        """Add ``| None`` for a nullable type, keeping presence and nullability distinct.

        This is the Python half of the §3.1 rule: `NotRequired[T]` means "may be absent" and
        `T | None` means "may be null". Collapsing them, as most generators do, loses information
        the spec took trouble to express.
        """
        if not is_nullable or annotation == "None":
            return annotation
        if annotation.endswith("| None") or annotation == "object":
            return annotation
        return f"{annotation} | None"

    def referenced_names(self, ref: Mapping[str, Any] | None, into: set[str]) -> None:
        """Collect the declared class names a type reference reaches.

        Without this a resource module annotated `list[Category]` never imported `Category`, and the
        generated package failed at import time. `mypy --strict` catches it, which is precisely the
        argument for the gate being non-negotiable rather than advisory.
        """
        if ref is None:
            return
        kind = ref.get("kind")
        if kind == "named":
            into.add(self.declared_name(ref["id"]))
        elif kind == "array":
            self.referenced_names(ref.get("items"), into)
        elif kind == "map":
            self.referenced_names(ref.get("values"), into)
        elif kind == "nullable":
            self.referenced_names(ref.get("inner"), into)
        elif kind == "union":
            for variant in ref.get("variants", []):
                self.referenced_names(variant, into)
