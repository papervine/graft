"""A structured code builder for Python.

AGENTS.md permits "ASTs *or* a structured code builder". For Python the builder is the right choice
on evidence rather than taste: `ast.unparse` **discards comments entirely** —
`ast.unparse(ast.parse("x = 1  # keep"))` returns `"x = 1"` — and the preservation regions that
`graft generate` carries across regeneration *are* comments. An `ast`-based target could not support
the feature the protocol's `lineComment` handshake field exists to enable.

What "not string templates" is actually about is kept: a module is a **model** of declarations,
imports are collected as the module is built and rendered once at the top, and layout is decided by
`ruff format` afterwards rather than by whitespace in this file.
"""

from __future__ import annotations

import textwrap
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

INDENT = "    "

# Matches the `line-length` in the generated `pyproject.toml`; `ruff format` will not reflow prose,
# so docstrings are wrapped to this width when they are built.
LINE_LENGTH = 100


def _docstring(text: str | None, indent: str) -> list[str]:
    """Render a docstring, escaping what would terminate it and wrapping what would overflow.

    Two things this has to get right, both learned from real specs:

    **Escaping.** A description containing a triple quote would close the string and inject a syntax
    error — the Python equivalent of the comment-close sequence that two GitHub descriptions
    contain.
    Backslashes are neutralised first, so a trailing one cannot escape the closing quotes.

    **Wrapping.** `ruff format` does not reflow docstrings or comments, so a long description stays
    a
    single 300-character line and fails the line-length lint. Prose has to be wrapped here, at the
    only point that knows the indent it will sit at.
    """
    if text is None or text.strip() == "":
        return []
    body = text.replace("\\", "\\\\").replace('"""', '\\"\\"\\"')
    # A description *ending* in a quote makes the closing delimiter four quotes, which is an
    # unterminated string. Stripe has one: `The user ID, if type is set to "user"`. Escaping only
    # embedded triple quotes was not enough — the character adjacent to the delimiter matters too.
    if body.endswith('"'):
        body = f'{body[:-1]}\\"'

    # `- 3` for the opening `"""`, which sits on the first line of prose. Without it every summary
    # line came out exactly three characters over the limit, which is how 424 lint errors in the
    # Twilio SDK turned out to be one off-by-three.
    width = max(40, LINE_LENGTH - len(indent) - 3)
    paragraphs = body.strip().split("\n")
    lines: list[str] = []
    for paragraph in paragraphs:
        stripped = paragraph.rstrip()
        if stripped == "":
            lines.append("")
            continue
        # A deeply indented line is a fenced or indented code block, and is left exactly as written:
        # rewrapping a code sample is how a generator turns a working example into a broken one.
        # Four spaces is the markdown threshold, and using it as the test matters — GitHub's
        # descriptions are full of two-space bullet lists, which are prose. Treating those as code
        # left 222 lint errors of unwrapped text.
        indent_width = len(paragraph) - len(paragraph.lstrip())
        if indent_width >= 4 or paragraph.startswith("\t"):
            lines.append(stripped)
            continue
        if indent_width > 0:
            # A list item keeps its marker on the first line and its continuations aligned under the
            # text, which is what markdown needs to still render it as one item.
            leading = paragraph[:indent_width]
            wrapped = textwrap.wrap(
                stripped,
                width=max(40, width - indent_width),
                subsequent_indent="  " if stripped[:1] in "-*+" else "",
            )
            lines.extend(f"{leading}{line}" for line in wrapped or [""])
            continue
        lines.extend(textwrap.wrap(stripped, width=width) or [""])

    while lines and lines[-1] == "":
        lines.pop()

    if len(lines) == 1 and len(lines[0]) + len(indent) + 6 <= LINE_LENGTH:
        return [f'{indent}"""{lines[0]}"""']

    out = [f'{indent}"""{lines[0]}']
    # No separator inserted here: the caller already put a blank line between the summary and the
    # body, and adding another produced a double blank inside every multi-line docstring.
    out.extend(f"{indent}{line}".rstrip() for line in lines[1:])
    out.append(f'{indent}"""')
    return out


@dataclass
class Param:
    name: str
    annotation: str | None = None
    default: str | None = None
    keyword_only: bool = False


@dataclass
class Function:
    name: str
    params: list[Param] = field(default_factory=list)
    returns: str | None = None
    body: list[str] = field(default_factory=list)
    docstring: str | None = None
    is_async: bool = False
    decorators: list[str] = field(default_factory=list)

    def render(self, indent: str = "") -> list[str]:
        out: list[str] = [f"{indent}@{d}" for d in self.decorators]
        prefix = "async def" if self.is_async else "def"

        rendered: list[str] = []
        seen_keyword_only = False
        for param in self.params:
            if param.keyword_only and not seen_keyword_only:
                rendered.append("*")
                seen_keyword_only = True
            text = param.name
            if param.annotation is not None:
                text += f": {param.annotation}"
            if param.default is not None:
                # PEP 8 spells a defaulted *annotated* parameter with spaces around `=`; ruff would
                # fix it either way, but emitting it correctly keeps the pre-format text readable
                # when debugging a manifest.
                text += (
                    f" = {param.default}" if param.annotation is not None else f"={param.default}"
                )
            rendered.append(text)

        signature = ", ".join(rendered)
        returns = f" -> {self.returns}" if self.returns is not None else ""
        # One line, however long. `ruff format` wraps it, and wrapping here would mean guessing at
        # its rules — which is exactly the string-template failure mode.
        out.append(f"{indent}{prefix} {self.name}({signature}){returns}:")

        inner = indent + INDENT
        out.extend(_docstring(self.docstring, inner))
        if self.body:
            out.extend(f"{inner}{line}" if line else "" for line in self.body)
        elif self.docstring is None:
            out.append(f"{inner}...")
        return out


@dataclass
class Attribute:
    """A class-level annotated assignment: ``name: annotation = default``."""

    name: str
    annotation: str
    default: str | None = None
    docstring: str | None = None


@dataclass
class Class:
    name: str
    bases: list[str] = field(default_factory=list)
    attributes: list[Attribute] = field(default_factory=list)
    methods: list[Function] = field(default_factory=list)
    docstring: str | None = None
    decorators: list[str] = field(default_factory=list)
    # Free text placed at the end of the class body. The one thing a structured model cannot express
    # and must not lose: the preservation-region markers.
    trailing: list[str] = field(default_factory=list)

    def render(self, indent: str = "") -> list[str]:
        out: list[str] = [f"{indent}@{d}" for d in self.decorators]
        bases = f"({', '.join(self.bases)})" if self.bases else ""
        out.append(f"{indent}class {self.name}{bases}:")

        inner = indent + INDENT
        out.extend(_docstring(self.docstring, inner))

        empty = not (self.attributes or self.methods or self.trailing)
        if empty:
            out.append(f"{inner}...")
            return out

        for attribute in self.attributes:
            line = f"{inner}{attribute.name}: {attribute.annotation}"
            if attribute.default is not None:
                line += f" = {attribute.default}"
            out.append(line)
            # A field docstring is a bare string after the annotation. Editors and pydantic's own
            # docs tooling both read it, and it is the only way to document a `TypedDict` member.
            out.extend(_docstring(attribute.docstring, inner))

        for method in self.methods:
            out.append("")
            out.extend(method.render(inner))

        if self.trailing:
            out.append("")
            out.extend(f"{inner}{line}" if line else "" for line in self.trailing)

        return out


@dataclass
class Assignment:
    """A module-level assignment, used for type aliases and literal unions."""

    name: str
    value: str
    annotation: str | None = None
    docstring: str | None = None

    def render(self, indent: str = "") -> list[str]:
        target = f"{self.name}: {self.annotation}" if self.annotation else self.name
        out = [f"{indent}{target} = {self.value}"]
        out.extend(_docstring(self.docstring, indent))
        return out


Statement = Class | Function | Assignment | str


class Module:
    """A Python module under construction.

    Imports are *requested* while the body is built and rendered once at the top, deduplicated and
    ordered. That is the property that makes this a builder rather than a template: nothing has to
    know its imports before it knows its contents.
    """

    def __init__(self, docstring: str | None = None) -> None:
        self.docstring = docstring
        self._future: set[str] = set()
        self._stdlib: dict[str, set[str]] = {}
        self._third_party: dict[str, set[str]] = {}
        self._local: dict[str, set[str]] = {}
        self._type_checking: dict[str, set[str]] = {}
        self._plain: set[str] = set()
        self.body: list[Statement] = []

    # -- imports ----------------------------------------------------------

    _STDLIB = frozenset(
        {
            "__future__",
            "collections",
            "collections.abc",
            "datetime",
            "decimal",
            "enum",
            "os",
            "typing",
            "urllib",
            "urllib.parse",
            "uuid",
        }
    )

    def _bucket(self, module: str) -> dict[str, set[str]]:
        if module.startswith("."):
            return self._local
        root = module.split(".")[0]
        if module in self._STDLIB or root in self._STDLIB:
            return self._stdlib
        return self._third_party

    def import_from(self, module: str, *names: str, type_checking: bool = False) -> None:
        """Request ``from <module> import <names>``.

        ``type_checking`` puts it behind ``if TYPE_CHECKING:``, which is how a runtime-free import
        is expressed in modern Python and what keeps a generated SDK's import time low. Only safe
        because every emitted module carries ``from __future__ import annotations``.
        """
        target = self._type_checking if type_checking else self._bucket(module)
        target.setdefault(module, set()).update(names)
        if type_checking:
            self._stdlib.setdefault("typing", set()).add("TYPE_CHECKING")

    def import_module(self, module: str) -> None:
        self._plain.add(module)

    def use_future_annotations(self) -> None:
        """Enable postponed annotation evaluation.

        Required, not optional: it is what lets a model reference a class defined later in the file
        without quoting, and what makes `if TYPE_CHECKING` imports work at all.
        """
        self._future.add("annotations")

    # -- body -------------------------------------------------------------

    def add(self, *statements: Statement) -> None:
        self.body.extend(statements)

    def extend(self, statements: Iterable[Statement]) -> None:
        self.body.extend(statements)

    # -- rendering --------------------------------------------------------

    def _render_group(self, group: dict[str, set[str]]) -> list[str]:
        lines: list[str] = []
        for module in sorted(group):
            names = sorted(group[module])
            if not names:
                continue
            lines.append(f"from {module} import {', '.join(names)}")
        return lines

    def render(self) -> str:
        out: list[str] = []
        out.extend(_docstring(self.docstring, ""))
        if out:
            out.append("")

        if self._future:
            out.append(f"from __future__ import {', '.join(sorted(self._future))}")
            out.append("")

        groups = [
            [f"import {m}" for m in sorted(self._plain)] + self._render_group(self._stdlib),
            self._render_group(self._third_party),
            self._render_group(self._local),
        ]
        for group in groups:
            if group:
                out.extend(group)
                out.append("")

        if self._type_checking:
            out.append("if TYPE_CHECKING:")
            for line in self._render_group(self._type_checking):
                out.append(f"{INDENT}{line}")
            out.append("")

        for statement in self.body:
            if isinstance(statement, str):
                out.append(statement)
            else:
                out.extend(statement.render())
            out.append("")

        text = "\n".join(out).rstrip("\n")
        return f"{text}\n"


def literal_union(values: Sequence[object], *, open_ended: bool) -> str:
    """Render a ``Literal[...]`` for an enum.

    Open enums union with ``str`` for the same reason the TypeScript target unions with
    ``(string & {})``: a server adds a value without warning, and an exhaustive type would turn that
    into a decode failure rather than a value the caller can still read.
    """
    if not values:
        return "str"
    rendered = ", ".join(repr(value) for value in values)
    literal = f"Literal[{rendered}]"
    return f"{literal} | str" if open_ended else literal
