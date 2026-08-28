"""The besdk Python target.

A subprocess that reads IR JSON on stdin and writes a file manifest on stdout. Written in Python so
it can use Python's own tooling — `ruff format` for layout, `mypy --strict` as the gate — because
that is the only way generated output matches what the community writes by hand.
"""

from .emit import PythonEmitter

__all__ = ["PythonEmitter"]
