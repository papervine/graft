/**
 * Verifying webhook signatures (SPEC.md §3.4.1.3).
 *
 * Hand-written, and it has to be. A generated HMAC comparison is short, security-critical, and has three
 * ways to be subtly wrong — each of which produces code that passes every test anyone would think to write:
 *
 * 1. **The HMAC must be computed over the raw request bytes.** Verifying a re-serialized body is the
 *    classic failure: it passes in testing and breaks the moment the sender's key order, whitespace, or
 *    unicode escaping differs from the receiver's serializer. So the entry point takes bytes or a string
 *    exactly as received, and parsing happens *after* verification succeeds.
 * 2. **The comparison must be constant-time.** A byte-by-byte early return leaks the expected signature to
 *    an attacker who can time responses.
 * 3. **A timestamp must be checked against a tolerance.** Without one a captured request stays valid
 *    forever, which makes the signature a bearer token rather than a proof of freshness.
 *
 * The provider's *scheme* is a descriptor rather than generated code, for the same reason response
 * validation is: the varying part is data, and one hand-written interpreter of that data is more
 * trustworthy than N generated verifiers. Stripe, GitHub, Slack, and Shopify differ only in the fields of
 * {@link WebhookSignatureScheme}.
 */

/** How a provider signs webhook requests. Mirrors `webhooks.signature` in the config. */
export interface WebhookSignatureScheme {
  readonly algorithm: 'sha256' | 'sha1' | 'sha512';
  readonly header: string;
  readonly format: 'bare' | 'prefixed' | 'structured';
  readonly prefix?: string;
  readonly signatureKey?: string;
  readonly timestampKey?: string;
  readonly timestampHeader?: string;
  readonly encoding: 'hex' | 'base64';
  readonly signedTemplate: string;
  readonly toleranceSeconds: number;
}

/**
 * Why verification failed.
 *
 * Its own error rather than a boolean, because the *reason* matters operationally: a bad signature means
 * someone sent you something, and a stale timestamp usually means your own queue is backed up. Conflating
 * them sends people to the wrong dashboard.
 *
 * The message never contains the expected signature or the secret. An error that helpfully prints what the
 * signature *should* have been is an oracle.
 */
export class WebhookVerificationError extends Error {
  readonly reason: 'missing-header' | 'malformed-header' | 'signature-mismatch' | 'timestamp-outside-tolerance';

  constructor(reason: WebhookVerificationError['reason'], message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.reason = reason;
  }
}

/** Headers as any framework hands them over: a plain object, or anything with a `get`. */
export type HeaderSource = Record<string, string | string[] | undefined> | { get(name: string): string | null };

function headerValue(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const found = (headers as { get(key: string): string | null }).get(name);
    return found ?? undefined;
  }
  // Case-insensitively, because HTTP header names are and a plain object is not. Node lowercases them,
  // Lambda does not, and a verifier that only worked behind one of them would be a trap.
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/** The `k=v,k=v` pairs of a structured header value, as Stripe and Slack use. */
function structuredPairs(value: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const part of value.split(',')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    pairs.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim());
  }
  return pairs;
}

/**
 * Compare two strings without leaking where they differ.
 *
 * Length is compared first and returned early, which is *not* a leak worth avoiding: a signature's length
 * is a property of the scheme, not of the secret, so an attacker already knows it.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  // `btoa` over a binary string, because it is the one encoder present in every runtime that has `fetch`.
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The signature a correctly-signed request would carry.
 *
 * `crypto.subtle` rather than Node's `crypto` module, so the runtime stays dependency-free and works in a
 * worker, an edge function, and Node alike — the same reason the transport uses `fetch`.
 */
async function expectedSignature(
  scheme: WebhookSignatureScheme,
  secret: string,
  signedPayload: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const algorithm = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }[
    scheme.algorithm.toUpperCase() as 'SHA1' | 'SHA256' | 'SHA512'
  ];
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload)));
  return scheme.encoding === 'base64' ? toBase64(digest) : toHex(digest);
}

/**
 * Verify a webhook's signature, throwing when it does not hold.
 *
 * Throws rather than returning false, so a handler that forgets to check the result is not silently
 * accepting forged requests. The one thing worse than no verification is verification whose failure is
 * ignorable.
 *
 * `body` must be the bytes as received. Passing a re-serialized object is the classic mistake, so the
 * signature accepts `string | Uint8Array | ArrayBuffer` and nothing else — an object would not compile.
 */
export async function verifyWebhookSignature(
  scheme: WebhookSignatureScheme,
  options: {
    readonly body: string | Uint8Array | ArrayBuffer;
    readonly headers: HeaderSource;
    readonly secret: string;
    /** Overridden only by tests, which must be able to verify a fixture signed at a fixed time. */
    readonly now?: Date;
  },
): Promise<void> {
  const raw = headerValue(options.headers, scheme.header);
  if (raw === undefined || raw === '') {
    throw new WebhookVerificationError(
      'missing-header',
      `The ${scheme.header} header was absent, so this request carries no signature to check.`,
    );
  }

  let signature: string | undefined;
  let timestamp: string | undefined;
  switch (scheme.format) {
    case 'bare':
      signature = raw;
      break;
    case 'prefixed': {
      const prefix = scheme.prefix ?? '';
      if (!raw.startsWith(prefix)) {
        throw new WebhookVerificationError(
          'malformed-header',
          `The ${scheme.header} header did not begin with \`${prefix}\`.`,
        );
      }
      signature = raw.slice(prefix.length);
      break;
    }
    case 'structured': {
      const pairs = structuredPairs(raw);
      signature = pairs.get(scheme.signatureKey ?? 'v1');
      timestamp = pairs.get(scheme.timestampKey ?? 't');
      if (signature === undefined) {
        throw new WebhookVerificationError(
          'malformed-header',
          `The ${scheme.header} header carried no \`${scheme.signatureKey ?? 'v1'}\` value.`,
        );
      }
      break;
    }
  }

  if (scheme.timestampHeader !== undefined) {
    timestamp = headerValue(options.headers, scheme.timestampHeader);
  }

  const bodyText =
    typeof options.body === 'string'
      ? options.body
      : new TextDecoder().decode(options.body instanceof Uint8Array ? options.body : new Uint8Array(options.body));

  // The tolerance check comes *before* the HMAC, because a stale request is rejected whatever it is signed
  // with, and doing the cheap check first avoids computing a digest for something already refused.
  if (scheme.toleranceSeconds > 0 && scheme.signedTemplate.includes('{timestamp}')) {
    if (timestamp === undefined || timestamp === '') {
      throw new WebhookVerificationError(
        'malformed-header',
        'The signature scheme signs a timestamp, but none was present to check.',
      );
    }
    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) {
      throw new WebhookVerificationError('malformed-header', `\`${timestamp}\` is not a unix timestamp.`);
    }
    const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
    // Absolute difference, so a request from the future is refused too. A clock ahead of yours is as
    // suspicious as one behind, and accepting it would let a captured request be replayed later.
    if (Math.abs(nowSeconds - sent) > scheme.toleranceSeconds) {
      throw new WebhookVerificationError(
        'timestamp-outside-tolerance',
        `The signature's timestamp is outside the ${scheme.toleranceSeconds}s tolerance.`,
      );
    }
  }

  const signedPayload = scheme.signedTemplate
    .replace('{timestamp}', timestamp ?? '')
    .replace('{body}', bodyText);
  const expected = await expectedSignature(scheme, options.secret, signedPayload);

  if (!timingSafeEqual(signature.toLowerCase(), expected.toLowerCase())) {
    throw new WebhookVerificationError(
      'signature-mismatch',
      'The signature did not match. Either the secret is wrong or this request was not sent by the API.',
    );
  }
}
