/**
 * Streaming responses.
 *
 * Server-sent events and newline-delimited JSON both become `AsyncIterable<T>`, so a caller
 * writes `for await (const event of client.events.stream())` — the same shape pagination uses.
 * Consistency here is worth more than exposing each protocol's peculiarities.
 *
 * Hand-written because the parsing is fiddly in ways a generator would get wrong per-endpoint:
 * SSE frames can span chunk boundaries, use either `\n\n` or `\r\n\r\n`, carry multi-line
 * `data:` fields, and include comment lines that must be ignored.
 */

import { SDKError } from './errors.js';

/** Thrown when a stream ends mid-frame or carries an undecodable payload. */
export class StreamDecodeError extends SDKError {}

/** Decode a `ReadableStream<Uint8Array>` into lines, tolerating chunk-split boundaries. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps multi-byte characters intact across chunk boundaries.
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        // Strip a trailing CR so CRLF streams behave identically to LF ones.
        yield buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer !== '') yield buffer.replace(/\r$/, '');
  } finally {
    // Releasing matters: an abandoned reader keeps the connection open.
    reader.releaseLock();
  }
}

/** A decoded server-sent event, before JSON parsing. */
export interface SSEFrame {
  readonly event: string | undefined;
  readonly data: string;
  readonly id: string | undefined;
  /**
   * The server's reconnection hint, in milliseconds.
   *
   * Surfaced rather than dropped because it is the one field only a caller writing their own reconnect
   * loop needs — and that loop is the caller's, deliberately (SPEC.md §3.4.1.2).
   */
  readonly retry: number | undefined;
}

/**
 * One streamed event with its framing metadata.
 *
 * What `streamEvents()` yields, where `stream()` yields `data` alone. Two methods rather than an option,
 * because the return type differs and an option that changes what a generator yields cannot be typed
 * without a union the caller has to narrow.
 */
export interface StreamEvent<T> {
  readonly data: T;
  /** Pass to `RequestOptions.lastEventId` on a later call to resume from here. */
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly retry: number | undefined;
}

/** Parse an SSE byte stream into frames. */
export async function* readSSEFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEFrame> {
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let data: string[] = [];

  const flush = (): SSEFrame | undefined => {
    if (data.length === 0 && event === undefined) return undefined;
    const frame: SSEFrame = { event, data: data.join('\n'), id, retry };
    event = undefined;
    id = undefined;
    // `retry` is *not* cleared with the rest. The spec makes it a connection-level setting rather than a
    // property of one event: a server sends it once and it governs every later reconnect, so clearing it
    // per frame would report it on the first event and never again.
    data = [];
    return frame;
  };

  for await (const line of readLines(stream)) {
    // A blank line terminates the current frame.
    if (line === '') {
      const frame = flush();
      if (frame !== undefined) yield frame;
      continue;
    }
    // Lines beginning with a colon are comments; servers use them as keep-alives.
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the framing, not the value.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'retry') {
      // Only when it parses as an integer, which the SSE spec requires — a non-numeric `retry` is defined
      // as ignorable, and passing NaN to a caller's `setTimeout` would hang the loop rather than fail it.
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) retry = parsed;
    }
    // Unknown fields are ignored, which the SSE spec requires.
  }

  const trailing = flush();
  if (trailing !== undefined) yield trailing;
}

/**
 * Decode an SSE response into typed events.
 *
 * `[DONE]` is recognized because it is the de facto sentinel for a completed stream and
 * would otherwise surface as a JSON parse failure on the last frame.
 */
export async function* streamSSE<T>(response: Response): AsyncGenerator<T> {
  if (response.body === null) return;
  for await (const frame of readSSEFrames(response.body)) {
    if (frame.data === '' || frame.data === '[DONE]') continue;
    yield decodeFrame<T>(frame.data);
  }
}

/**
 * Decode an SSE response into typed events with their framing metadata.
 *
 * The sibling of {@link streamSSE}: same payloads, plus the `id` a caller needs to resume and the `retry`
 * the server suggested waiting. graft does not reconnect — see SPEC.md §3.4.1.2 for why that is a decision
 * rather than an omission.
 */
export async function* streamSSEEvents<T>(response: Response): AsyncGenerator<StreamEvent<T>> {
  if (response.body === null) return;
  for await (const frame of readSSEFrames(response.body)) {
    if (frame.data === '' || frame.data === '[DONE]') continue;
    yield {
      data: decodeFrame<T>(frame.data),
      id: frame.id,
      event: frame.event,
      retry: frame.retry,
    };
  }
}

/** Decode a newline-delimited JSON response into typed events. */
export async function* streamJSONLines<T>(response: Response): AsyncGenerator<T> {
  if (response.body === null) return;
  for await (const line of readLines(response.body)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    yield decodeFrame<T>(trimmed);
  }
}

/**
 * Decode a newline-delimited JSON response, in the metadata shape.
 *
 * JSONL carries no framing, so `id`, `event`, and `retry` are always absent — the method exists so a
 * generated resource can offer `streamEvents()` regardless of which encoding the spec declared, rather
 * than making the caller know which one they got.
 */
export async function* streamJSONLineEvents<T>(response: Response): AsyncGenerator<StreamEvent<T>> {
  for await (const data of streamJSONLines<T>(response)) {
    yield { data, id: undefined, event: undefined, retry: undefined };
  }
}

function decodeFrame<T>(payload: string): T {
  try {
    return JSON.parse(payload) as T;
  } catch (cause) {
    throw new StreamDecodeError(`Could not decode stream payload: ${payload.slice(0, 120)}`, {
      cause,
    });
  }
}
