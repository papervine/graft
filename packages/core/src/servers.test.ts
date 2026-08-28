/**
 * Templated server URLs (SPEC.md §3.4.0.2).
 *
 * The bug these pin: besdk passed a templated URL through untouched, so every request in a generated
 * SDK went to a host containing literal braces. A URL with `{region}` in it does not resolve, and the
 * failure surfaced as a DNS error at the first call rather than at generation time.
 */

import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { buildIR, inspectSpec } from './index.js';

function ir(servers: unknown) {
  const yaml = stringify({
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    servers,
    paths: {
      '/widgets': {
        get: {
          operationId: 'listWidgets',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } },
            },
          },
        },
      },
    },
  });
  return buildIR(inspectSpec(yaml, 'test.yaml'), {});
}

describe('server variables', () => {
  it('substitutes defaults so the base URL resolves', () => {
    const { ir: built } = ir([
      {
        url: 'https://{region}.api.example.com/{version}',
        variables: {
          region: { default: 'us-east-1', enum: ['us-east-1', 'eu-west-1'] },
          version: { default: 'v2' },
        },
      },
    ]);
    const server = built.service.servers[0]!;
    expect(server.url).toBe('https://us-east-1.api.example.com/v2');
    // The template is kept alongside, because a target that exposes variables needs the shape to
    // re-substitute into and it cannot be recovered from the resolved URL.
    expect(server.urlTemplate).toBe('https://{region}.api.example.com/{version}');
    expect(server.variables?.map((v) => v.wireName)).toEqual(['region', 'version']);
    expect(server.variables?.[0]?.enum).toEqual(['us-east-1', 'eu-west-1']);
  });

  it('substitutes a variable that appears more than once', () => {
    const { ir: built } = ir([
      { url: 'https://{env}.api.example.com/{env}', variables: { env: { default: 'staging' } } },
    ]);
    expect(built.service.servers[0]?.url).toBe('https://staging.api.example.com/staging');
  });

  it('leaves an untemplated server untouched, with no variables recorded', () => {
    const { ir: built } = ir([{ url: 'https://api.example.com' }]);
    const server = built.service.servers[0]!;
    expect(server.url).toBe('https://api.example.com');
    expect(server.urlTemplate).toBeUndefined();
    expect(server.variables).toBeUndefined();
  });

  it('ignores a declared variable the URL never references', () => {
    // Emitting a client option for it would invite a caller to set something with no effect.
    const { ir: built } = ir([
      {
        url: 'https://{region}.api.example.com',
        variables: { region: { default: 'us-east-1' }, unused: { default: 'x' } },
      },
    ]);
    expect(built.service.servers[0]?.variables?.map((v) => v.wireName)).toEqual(['region']);
  });

  it('warns when a placeholder has no declaration, and leaves it visible', () => {
    const { ir: built, diagnostics } = ir([{ url: 'https://{tenant}.api.example.com' }]);
    // No default exists, so there is nothing to substitute. Left in place rather than stripped: a
    // literal `{tenant}` is obviously wrong to a reader, where `https://.api.example.com` is not.
    expect(built.service.servers[0]?.url).toBe('https://{tenant}.api.example.com');
    const warning = diagnostics.find((d) => d.code === 'S003');
    expect(warning?.severity).toBe('warn');
    expect(warning?.detail).toEqual(['{tenant}']);
  });

  it('falls back to the first enum member when the spec omits the required default', () => {
    // OpenAPI requires `default`; specs omit it. An empty substitution would produce
    // `https://.api.example.com`, which resolves to nothing and looks plausible.
    const { ir: built } = ir([
      { url: 'https://{region}.api.example.com', variables: { region: { enum: ['eu-west-1'] } } },
    ]);
    expect(built.service.servers[0]?.url).toBe('https://eu-west-1.api.example.com');
  });
});
