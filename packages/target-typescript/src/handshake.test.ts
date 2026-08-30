/**
 * What this target tells the core about itself.
 *
 * Both assertions here pin bugs that were live. The capability list claimed two of the five things this
 * target emits, and `graft targets` prints that list — so an author reading the reference target to see
 * what is expected of theirs was told less than the truth. And no gates were declared at all, which the
 * core papered over with a hardcoded prettier-and-tsc branch: the language-specific table SPEC.md §3.7
 * exists to prevent, kept alive for the one target that ships the protocol.
 */

import { describe, expect, it } from 'vitest';
import { IR_VERSION } from '@graft/protocol';
import { handshake } from './index.js';

describe('handshake', () => {
  it('accepts the IR the core emits', () => {
    expect(handshake.irVersions).toContain(`${IR_VERSION.split('.')[0]}.x`);
  });

  it('declares every capability it actually implements', () => {
    // Each of these is emitted and tested: `async *stream()` over SSE, Blob/stream binary responses,
    // and FormData multipart bodies.
    expect(handshake.capabilities).toEqual(
      expect.arrayContaining([
        'pagination',
        'streaming',
        'binary-responses',
        'multipart-requests',
        'read-write-split',
      ]),
    );
  });

  it('does not claim sync-and-async, because every method returns a promise', () => {
    // TypeScript has no synchronous HTTP. Python declares this because it emits both clients; claiming
    // it here would be a capability the core could act on and this target could not honour.
    expect(handshake.capabilities).not.toContain('sync-and-async');
  });

  it('declares its own gates, with a formatter before the typechecker', () => {
    const names = (handshake.gates ?? []).map((gate) => gate.name);
    expect(names).toContain('tsc');
    expect(names.indexOf('prettier')).toBeLessThan(names.indexOf('tsc'));
  });

  it('marks the formatter fix and the typechecker verify', () => {
    const gates = handshake.gates ?? [];
    // A formatter's exit code is not a verdict on the output: `ruff check --fix` exits non-zero for
    // what it could not fix, which the next step would have wrapped anyway.
    expect(gates.find((g) => g.name === 'prettier')?.kind).toBe('fix');
    expect(gates.find((g) => g.name === 'tsc')?.kind).toBe('verify');
  });

  it('never marks a typecheck optional', () => {
    // Skipping a formatter costs cosmetics. Skipping a typechecker removes the guarantee the whole
    // pipeline is premised on.
    for (const gate of handshake.gates ?? []) {
      if (gate.name.startsWith('tsc')) expect(gate.optional).not.toBe(true);
    }
  });

  it("emits absolute paths, since the core cannot resolve this package's dependencies", () => {
    for (const gate of handshake.gates ?? []) {
      expect(gate.command[0]).toMatch(/^\//);
      expect(gate.command[1]).toMatch(/^\//);
    }
  });
});
