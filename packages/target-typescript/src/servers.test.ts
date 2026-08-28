/**
 * Templated server URLs in the emitted client (SPEC.md §3.4.0.2).
 *
 * The core resolves the default so a target that ignores variables still produces a working SDK. What
 * is tested here is the other half: each variable becomes a client option, so a caller configures a
 * region rather than assembling a hostname.
 */

import { describe, expect, it } from 'vitest';
import { brandPayload } from '@besdk/protocol';
import type { IR, Server } from '@besdk/protocol';
import { TypeScriptEmitter } from './emit.js';

const docs = {};

function ir(servers: Server[]): IR {
  return {
    irVersion: '1.5.0',
    service: {
      name: { tokens: ['acme'] },
      version: '1',
      docs,
      servers,
      auth: [],
      constantHeaders: {},
    },
    types: [],
    resources: [],
    errors: { byStatus: [] },
    pagination: [],
  };
}

function client(servers: Server[]): string {
  const files = new TypeScriptEmitter(ir(servers), {
    runtimeFiles: new Map(),
    brand: brandPayload(),
  }).emit();
  return files.find((file) => file.path === 'src/client.ts')?.contents ?? '';
}

const templated: Server = {
  id: 'default',
  url: 'https://us-east-1.api.example.com/v2',
  urlTemplate: 'https://{region}.api.example.com/{version}',
  variables: [
    {
      wireName: 'region',
      name: { tokens: ['region'] },
      default: 'us-east-1',
      enum: ['us-east-1', 'eu-west-1'],
      description: 'Data residency.',
    },
    { wireName: 'version', name: { tokens: ['version'] }, default: 'v2' },
  ],
  default: true,
};

describe('server variables', () => {
  it('becomes one client option per variable, with an enum as a union', () => {
    const source = client([templated]);
    // A union rather than `string`: the spec listed the valid values, and widening them would leave a
    // caller guessing at a region name.
    expect(source).toContain(`region?: "us-east-1" | "eu-west-1"`);
    expect(source).toContain('version?: string');
    // The description belongs on the option, which is where an editor shows it.
    expect(source).toContain('Data residency.');
    expect(source).toContain('Defaults to `us-east-1`');
  });

  it('builds the base URL as a template literal reading those options', () => {
    // Emitted inline rather than through a runtime helper, because the result says exactly what it
    // does and a helper would not.
    expect(client([templated])).toContain(
      'options.baseURL ?? `https://${options.region ?? "us-east-1"}.api.example.com/${options.version ?? "v2"}`',
    );
  });

  it('leaves an untemplated server as a plain string literal', () => {
    const source = client([
      { id: 'default', url: 'https://api.acme.com', default: true },
    ]);
    expect(source).toContain('options.baseURL ?? "https://api.acme.com"');
    expect(source).not.toContain('region?');
  });

  it('substitutes a variable that appears twice', () => {
    const source = client([
      {
        id: 'default',
        url: 'https://staging.api.example.com/staging',
        urlTemplate: 'https://{env}.api.example.com/{env}',
        variables: [{ wireName: 'env', name: { tokens: ['env'] }, default: 'staging' }],
        default: true,
      },
    ]);
    expect(source).toContain(
      '`https://${options.env ?? "staging"}.api.example.com/${options.env ?? "staging"}`',
    );
  });
});
