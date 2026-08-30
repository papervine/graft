"""The target protocol entry point (SPEC.md §3.5).

    graft-target-python --sdk-target-protocol   → handshake on stdout
    graft-target-python                         → IR JSON on stdin, manifest on stdout

This is the first target that is not a Node program, which is the whole reason the protocol is a
subprocess boundary rather than a plugin API. Nothing here imports anything from graft's core: the
contract is the JSON, and that is what makes a target in *any* language possible.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .emit import PythonEmitter

# The flag the core probes a target with. Carries no project name on purpose: a target hardcodes it
# because it cannot import the constant that owns it, so the flag is a promise to third-party target
# authors rather than an internal detail. See `branding.ts`.
HANDSHAKE_FLAG = "--sdk-target-protocol"

# Kept in step with `packages/protocol/src/branding.ts`. A target declares its own name and the IR
# range it understands; the core refuses to run on a mismatch rather than emit a subtly wrong SDK.
HANDSHAKE = {
    "name": "python",
    "displayName": "Python",
    "version": "0.0.0",
    "irVersions": ["1.x"],
    "capabilities": [
        "pagination",
        "streaming",
        "binary-responses",
        "multipart-requests", "read-write-split",
        "sync-and-async",
    ],
    # `#` is what lets the core find preservation markers without knowing Python.
    "lineComment": "#",
}


def _gates() -> list[dict[str, object]]:
    """The verification gates for generated Python, resolved against this interpreter.

    Declared by the target rather than hardcoded in graft's core: only the target knows that Python
    means ruff and mypy, and the core knowing would be the boundary violation SPEC.md §3.7 exists to
    prevent.

    `sys.executable -m` rather than a bare `ruff`/`mypy`: the tools must come from the same
    environment as this target, or a user with a different global `mypy` gets confusing failures
    that
    have nothing to do with their spec.

    Order matters. `ruff check --fix` sorts imports and applies safe fixes, then `ruff format`
    decides layout, then `ruff check` confirms nothing was left, and only then does `mypy` run — so
    it reports positions in the final text. Formatting is `optional` because a missing formatter
    degrades to ugly-but-correct output; the typechecker is not, because skipping it would remove
    the
    guarantee the whole pipeline is premised on.
    """
    ruff = [sys.executable, "-m", "ruff"]
    return [
        {
            "name": "ruff check --fix",
            "command": [*ruff, "check", "--fix", "--quiet", "."],
            "kind": "fix",
            "optional": True,
        },
        {
            "name": "ruff format",
            "command": [*ruff, "format", "--quiet", "."],
            "kind": "fix",
            "optional": True,
        },
        {
            "name": "ruff check",
            "command": [*ruff, "check", "."],
            "kind": "verify",
            "optional": True,
        },
        {
            # `examples` too, so a generated example that no longer typechecks fails
            # generation rather than shipping a snippet that lies. The tests are excluded
            # because they import `pytest`, which the *output* directory need not have
            # installed — the same asymmetry the TypeScript target documents (§3.11).
            "name": "mypy --strict",
            "command": [sys.executable, "-m", "mypy", "--strict", "src", "examples"],
            "kind": "verify",
        },
        {
            # The generated per-operation tests, run as a gate. Optional because a test
            # runner has to be importable, and a first generation into an empty directory
            # has installed nothing — failing generation over an absent dev dependency
            # would make the feature a liability.
            "name": "generated tests",
            "command": [sys.executable, "-m", "pytest", "-q", "tests"],
            "kind": "verify",
            "optional": True,
        },
    ]


def load_runtime_sources() -> dict[str, str]:
    """Read the hand-written runtime for vendoring into the output.

    Read from the installed package rather than inlined as string constants, so the runtime stays a
    normal library that its own test suite exercises. Tests are excluded: they belong to graft's
    repository, not to a user's SDK.
    """
    here = Path(__file__).resolve()
    candidates = [
        here.parents[3] / "runtime-python" / "src" / "graft_runtime",
        here.parents[2] / "graft_runtime",
    ]
    for directory in candidates:
        if not directory.is_dir():
            continue
        files: dict[str, str] = {}
        for path in sorted(directory.glob("*.py")):
            if path.name.startswith("test_"):
                continue
            files[path.name] = path.read_text(encoding="utf-8")
        if files:
            return files
    searched = ", ".join(str(c) for c in candidates)
    raise RuntimeError(f"No runtime sources found. Looked in: {searched}")


def main(argv: list[str]) -> int:
    if HANDSHAKE_FLAG in argv:
        sys.stdout.write(f"{json.dumps({**HANDSHAKE, 'gates': _gates()})}\n")
        return 0

    raw = sys.stdin.read()
    if raw.strip() == "":
        sys.stderr.write("graft-target-python: expected IR JSON on stdin\n")
        return 2

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        sys.stderr.write(f"graft-target-python: stdin was not valid JSON: {error}\n")
        return 2

    ir = payload.get("ir")
    if not isinstance(ir, dict):
        sys.stderr.write("graft-target-python: input had no `ir` object\n")
        return 2

    options = payload.get("options") or {}
    brand = payload.get("brand") or {}
    emitter = PythonEmitter(ir, options, brand)
    runtime = load_runtime_sources()
    # `_core/__init__.py` re-exports the runtime, and the vendored copy keeps its own filenames, so
    # imports inside it resolve unchanged.
    files = emitter.emit(runtime)

    sys.stdout.write(f"{json.dumps({'files': files, 'warnings': emitter.warnings})}\n")
    return 0


def cli() -> None:
    """Console-script entry point, so `graft-target-python` works when installed on PATH."""
    sys.exit(main(sys.argv[1:]))


if __name__ == "__main__":
    cli()
