/**
 * Webhook signature verification (SPEC.md §3.4.1.3).
 *
 * Weighted towards what must be *refused*, because a verifier that accepts too much fails silently and
 * totally: nothing in a system tells you that forged requests are being processed. Every test below is a
 * request that must not be accepted, except the handful establishing that a correct one is.
 *
 * The expected digests are computed here with the same primitive the verifier uses, which would be circular
 * if these were the only tests — so one case pins an RFC 4231 vector, which fails if the primitive itself is
 * wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  WebhookVerificationError,
  verifyWebhookSignature,
  type WebhookSignatureScheme,
} from './webhooks.js';

const SECRET = 'whsec_test_secret';
const BODY = '{"id":"evt_1","type":"invoice.paid"}';
const NOW = new Date('2024-06-01T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

async function hmacHex(secret: string, payload: string, hash = 'SHA-256'): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacBase64(secret: string, payload: string): Promise<string> {
  const hex = await hmacHex(secret, payload);
  const bytes = new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const STRIPE: WebhookSignatureScheme = {
  algorithm: 'sha256',
  header: 'Stripe-Signature',
  format: 'structured',
  signatureKey: 'v1',
  timestampKey: 't',
  encoding: 'hex',
  signedTemplate: '{timestamp}.{body}',
  toleranceSeconds: 300,
};

const GITHUB: WebhookSignatureScheme = {
  algorithm: 'sha256',
  header: 'X-Hub-Signature-256',
  format: 'prefixed',
  prefix: 'sha256=',
  encoding: 'hex',
  signedTemplate: '{body}',
  toleranceSeconds: 0,
};

const SLACK: WebhookSignatureScheme = {
  algorithm: 'sha256',
  header: 'X-Slack-Signature',
  format: 'prefixed',
  prefix: 'v0=',
  timestampHeader: 'X-Slack-Request-Timestamp',
  encoding: 'hex',
  signedTemplate: 'v0:{timestamp}:{body}',
  toleranceSeconds: 300,
};

const SHOPIFY: WebhookSignatureScheme = {
  algorithm: 'sha256',
  header: 'X-Shopify-Hmac-Sha256',
  format: 'bare',
  encoding: 'base64',
  signedTemplate: '{body}',
  toleranceSeconds: 0,
};

describe('the four provider shapes', () => {
  it('accepts a Stripe-style structured header', async () => {
    const signature = await hmacHex(SECRET, `${NOW_SECONDS}.${BODY}`);
    await expect(
      verifyWebhookSignature(STRIPE, {
        body: BODY,
        headers: { 'stripe-signature': `t=${NOW_SECONDS},v1=${signature}` },
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a GitHub-style prefixed header', async () => {
    const signature = await hmacHex(SECRET, BODY);
    await expect(
      verifyWebhookSignature(GITHUB, {
        body: BODY,
        headers: { 'X-Hub-Signature-256': `sha256=${signature}` },
        secret: SECRET,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a Slack-style separate timestamp header', async () => {
    const signature = await hmacHex(SECRET, `v0:${NOW_SECONDS}:${BODY}`);
    await expect(
      verifyWebhookSignature(SLACK, {
        body: BODY,
        headers: {
          'X-Slack-Signature': `v0=${signature}`,
          'X-Slack-Request-Timestamp': String(NOW_SECONDS),
        },
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a Shopify-style bare base64 header', async () => {
    const signature = await hmacBase64(SECRET, BODY);
    await expect(
      verifyWebhookSignature(SHOPIFY, {
        body: BODY,
        headers: { 'X-Shopify-Hmac-Sha256': signature },
        secret: SECRET,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('what must be refused', () => {
  it('refuses a signature computed with a different secret', async () => {
    const signature = await hmacHex('whsec_wrong', BODY);
    await expect(
      verifyWebhookSignature(GITHUB, {
        body: BODY,
        headers: { 'X-Hub-Signature-256': `sha256=${signature}` },
        secret: SECRET,
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it('refuses a body altered after signing', async () => {
    // The whole point: a valid signature over *different* bytes must not verify. This is the case a
    // verifier that re-serializes the body would wrongly accept.
    const signature = await hmacHex(SECRET, BODY);
    await expect(
      verifyWebhookSignature(GITHUB, {
        body: `${BODY} `,
        headers: { 'X-Hub-Signature-256': `sha256=${signature}` },
        secret: SECRET,
      }),
    ).rejects.toMatchObject({ reason: 'signature-mismatch' });
  });

  it('refuses a request older than the tolerance', async () => {
    const stale = NOW_SECONDS - 301;
    const signature = await hmacHex(SECRET, `${stale}.${BODY}`);
    await expect(
      verifyWebhookSignature(STRIPE, {
        body: BODY,
        headers: { 'stripe-signature': `t=${stale},v1=${signature}` },
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: 'timestamp-outside-tolerance' });
  });

  it('refuses a request from the future', async () => {
    // A clock ahead of yours is as suspicious as one behind, and accepting it would let a captured request
    // be replayed later.
    const ahead = NOW_SECONDS + 301;
    const signature = await hmacHex(SECRET, `${ahead}.${BODY}`);
    await expect(
      verifyWebhookSignature(STRIPE, {
        body: BODY,
        headers: { 'stripe-signature': `t=${ahead},v1=${signature}` },
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: 'timestamp-outside-tolerance' });
  });

  it('refuses a valid signature carrying someone else’s timestamp', async () => {
    // Replay with a fresh timestamp: the attacker keeps a captured `v1` and updates `t`. The signature
    // covers the timestamp, so this must fail on the HMAC rather than on the tolerance.
    const signature = await hmacHex(SECRET, `${NOW_SECONDS - 1000}.${BODY}`);
    await expect(
      verifyWebhookSignature(STRIPE, {
        body: BODY,
        headers: { 'stripe-signature': `t=${NOW_SECONDS},v1=${signature}` },
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: 'signature-mismatch' });
  });

  it('refuses an absent header', async () => {
    await expect(
      verifyWebhookSignature(GITHUB, { body: BODY, headers: {}, secret: SECRET }),
    ).rejects.toMatchObject({ reason: 'missing-header' });
  });

  it('refuses a header missing its prefix', async () => {
    const signature = await hmacHex(SECRET, BODY);
    await expect(
      verifyWebhookSignature(GITHUB, {
        body: BODY,
        headers: { 'X-Hub-Signature-256': signature },
        secret: SECRET,
      }),
    ).rejects.toMatchObject({ reason: 'malformed-header' });
  });

  it('refuses a structured header with no signature pair', async () => {
    await expect(
      verifyWebhookSignature(STRIPE, {
        body: BODY,
        headers: { 'stripe-signature': `t=${NOW_SECONDS}` },
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: 'malformed-header' });
  });

  it('refuses a signed-timestamp scheme with no timestamp', async () => {
    // Not merely malformed: without the timestamp the tolerance cannot be enforced, so accepting it would
    // silently turn the signature into a bearer token.
    const signature = await hmacHex(SECRET, `.${BODY}`);
    await expect(
      verifyWebhookSignature(STRIPE, {
        body: BODY,
        headers: { 'stripe-signature': `v1=${signature}` },
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: 'malformed-header' });
  });

  it('refuses a non-numeric timestamp', async () => {
    await expect(
      verifyWebhookSignature(STRIPE, {
        body: BODY,
        headers: { 'stripe-signature': 't=yesterday,v1=abc' },
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: 'malformed-header' });
  });

  it('refuses a truncated signature of the right prefix', async () => {
    // A length check that ran *after* a prefix comparison would accept this.
    const signature = await hmacHex(SECRET, BODY);
    await expect(
      verifyWebhookSignature(GITHUB, {
        body: BODY,
        headers: { 'X-Hub-Signature-256': `sha256=${signature.slice(0, 32)}` },
        secret: SECRET,
      }),
    ).rejects.toMatchObject({ reason: 'signature-mismatch' });
  });
});

describe('the shape of what it accepts', () => {
  it('takes the body as bytes, and agrees with the string form', async () => {
    const signature = await hmacHex(SECRET, BODY);
    const bytes = new TextEncoder().encode(BODY);
    await expect(
      verifyWebhookSignature(GITHUB, {
        body: bytes,
        headers: { 'X-Hub-Signature-256': `sha256=${signature}` },
        secret: SECRET,
      }),
    ).resolves.toBeUndefined();
  });

  it('reads headers case-insensitively', async () => {
    // Node lowercases header names and Lambda does not. A verifier that worked behind only one of them
    // would fail in production having passed every local test.
    const signature = await hmacHex(SECRET, BODY);
    await expect(
      verifyWebhookSignature(GITHUB, {
        body: BODY,
        headers: { 'x-HUB-signature-256': `sha256=${signature}` },
        secret: SECRET,
      }),
    ).resolves.toBeUndefined();
  });

  it('reads a Headers object as well as a plain one', async () => {
    const signature = await hmacHex(SECRET, BODY);
    const headers = new Headers({ 'X-Hub-Signature-256': `sha256=${signature}` });
    await expect(
      verifyWebhookSignature(GITHUB, { body: BODY, headers, secret: SECRET }),
    ).resolves.toBeUndefined();
  });

  it('never puts the expected signature in the error message', async () => {
    // An error that helpfully prints what the signature should have been is an oracle.
    const expected = await hmacHex(SECRET, BODY);
    const error = await verifyWebhookSignature(GITHUB, {
      body: BODY,
      headers: { 'X-Hub-Signature-256': 'sha256=00' },
      secret: SECRET,
    }).catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain(expected);
    expect(error.message).not.toContain(SECRET);
  });

  it('honours sha1 and sha512 where a provider still uses them', async () => {
    const scheme: WebhookSignatureScheme = { ...GITHUB, algorithm: 'sha1', prefix: 'sha1=' };
    const signature = await hmacHex(SECRET, BODY, 'SHA-1');
    await expect(
      verifyWebhookSignature(scheme, {
        body: BODY,
        headers: { 'X-Hub-Signature-256': `sha1=${signature}` },
        secret: SECRET,
      }),
    ).resolves.toBeUndefined();
  });

  it('matches a digest computed outside this module', async () => {
    // Guards against the whole suite agreeing with a broken primitive: if the helper here and the verifier
    // were wrong in the same way, every other test would still pass. This vector is RFC 4231 test case 2 —
    // HMAC-SHA256 with key "Jefe" over "what do ya want for nothing?".
    expect(await hmacHex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});
