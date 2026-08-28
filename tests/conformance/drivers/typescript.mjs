/**
 * The TypeScript conformance driver.
 *
 * Runs every shared scenario against the mock server using the *generated* SDK, and prints what it
 * observed as JSON on stdout. The runner compares that against the scenario expectations and against
 * the other languages' drivers.
 *
 * Calls are written natively — `client.orgs.listMembers('o1', { limit: 2 })` — because the point is
 * that idiomatic code in each language produces identical wire behaviour. A data-driven driver that
 * dispatched on operation names would prove nothing about idiom.
 *
 * Usage: node typescript.mjs <baseURL>
 */

import {
  KitchenSink,
  NotFoundError,
  BadRequestError,
  ResponseValidationError,
} from '../../../sdks/kitchen-sink/dist/index.js';

const baseURL = process.argv[2];
if (!baseURL) {
  process.stderr.write('usage: typescript.mjs <baseURL>\n');
  process.exit(2);
}

/** A client pinned to one scenario, so the server knows which script to replay. */
function client(scenario, maxRetries = 0) {
  // This spec declares an API key, not a bearer token — the generated options interface has no
  // `token` at all. Getting this wrong is what surfaced the generator emitting a `{ token: … }`
  // example for an apiKey-only spec: a documented snippet that could not compile.
  return new KitchenSink({
    baseURL,
    apiKey: 'key_conformance',
    maxRetries,
    defaultHeaders: { 'X-Scenario': scenario },
  });
}

/** Every value is stringified so three languages' numeric types cannot differ cosmetically. */
const s = (v) => String(v);

const scenarios = {
  async list_categories() {
    const categories = await client('list_categories').categories.list();
    return {
      count: s(categories.length),
      first_slug: s(categories[0].slug),
      second_name: s(categories[1].name),
    };
  },

  async paginate_members() {
    const emails = [];
    for await (const member of client('paginate_members').orgs.listMembers('o1', { limit: 2 })) {
      emails.push(member.email);
    }
    return { emails: emails.join(','), count: s(emails.length) };
  },

  async query_serialization() {
    // `since` is deliberately omitted: an absent optional parameter must not reach the wire at all.
    const results = await client('query_serialization').search.query({ q: 'sprocket', kind: 'member' });
    return { count: s(results.length) };
  },

  async path_escaping() {
    const pdf = await client('path_escaping').orgs.invoices.downloadPdf('a/b', 'i1');
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    return { byte_length: s(bytes.length) };
  },

  async error_404() {
    try {
      for await (const _ of client('error_404').orgs.listMembers('missing')) {
        // Draining is required: the paginator is lazy, so the request happens on iteration.
      }
      return { error_kind: 'none' };
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        return { error_kind: `wrong:${error?.constructor?.name}` };
      }
      return {
        error_kind: 'not_found',
        status: s(error.status),
        message: s(error.message),
        request_id: s(error.requestId),
      };
    }
  },

  async retry_then_success() {
    // An idempotency key, because a POST without one is no longer retried — deduplication has to
    // happen on the server.
    const receipt = await client('retry_then_success', 2).events.publish(
      { type: 'widget.created' },
      { idempotencyKey: 'conformance_1' },
    );
    return { accepted: s(receipt.accepted), event_id: s(receipt.event_id) };
  },

  async no_retry_without_idempotency_key() {
    try {
      await client('no_retry_without_idempotency_key', 2).events.publish({ type: 'widget.created' });
      return { error_kind: 'none' };
    } catch (error) {
      return { error_kind: error?.status >= 500 ? 'server_error' : `wrong:${error?.constructor?.name}` };
    }
  },

  async no_retry_on_400() {
    try {
      await client('no_retry_on_400', 2).events.publish({ type: 'widget.created' });
      return { error_kind: 'none' };
    } catch (error) {
      if (!(error instanceof BadRequestError)) {
        return { error_kind: `wrong:${error?.constructor?.name}` };
      }
      return { error_kind: 'bad_request' };
    }
  },

  async validation_catches_a_broken_contract() {
    try {
      await client('validation_catches_a_broken_contract').categories.list();
      return { error_kind: 'none' };
    } catch (error) {
      if (!(error instanceof ResponseValidationError)) {
        return { error_kind: `wrong:${error?.constructor?.name}` };
      }
      return { error_kind: 'validation', path: error.problems[0].path };
    }
  },

  async validation_on_a_paginated_response() {
    try {
      for await (const _ of client('validation_on_a_paginated_response').orgs.listMembers('o1')) {
        // Draining is required: the paginator is lazy.
      }
      return { error_kind: 'none' };
    } catch (error) {
      if (!(error instanceof ResponseValidationError)) {
        return { error_kind: `wrong:${error?.constructor?.name}` };
      }
      return { error_kind: 'validation', path: error.problems[0].path };
    }
  },

  async validation_allows_an_additive_field() {
    const categories = await client('validation_allows_an_additive_field').categories.list();
    return { count: s(categories.length), first_slug: s(categories[0].slug) };
  },

  async text_response() {
    const csv = await client('text_response').reports.exportUsage();
    const lines = csv.trimEnd().split('\n');
    return { text_starts_with: lines[0], line_count: s(lines.length) };
  },
};

const observed = {};
for (const [name, run] of Object.entries(scenarios)) {
  try {
    observed[name] = await run();
  } catch (error) {
    observed[name] = { _error: `${error?.constructor?.name}: ${error?.message}` };
  }
}
process.stdout.write(JSON.stringify({ language: 'typescript', observed }, null, 2));
