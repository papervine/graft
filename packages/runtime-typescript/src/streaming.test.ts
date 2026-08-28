import { describe, expect, it } from 'vitest';
import {
  StreamDecodeError,
  readSSEFrames,
  streamJSONLineEvents,
  streamJSONLines,
  streamSSE,
  streamSSEEvents,
} from './streaming.js';

/** Build a byte stream, optionally split at arbitrary points to simulate chunking. */
function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseResponse(...chunks: string[]): Response {
  return new Response(stream(...chunks), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('SSE framing', () => {
  it('parses simple frames', async () => {
    const frames = await collect(readSSEFrames(stream('data: one\n\ndata: two\n\n')));
    expect(frames.map((f) => f.data)).toEqual(['one', 'two']);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    // The failure mode this guards: a naive per-chunk parser drops or duplicates events
    // whenever a frame straddles a TCP read.
    const frames = await collect(readSSEFrames(stream('data: hel', 'lo\n', '\n')));
    expect(frames.map((f) => f.data)).toEqual(['hello']);
  });

  it('handles CRLF line endings', async () => {
    const frames = await collect(readSSEFrames(stream('data: one\r\n\r\n')));
    expect(frames.map((f) => f.data)).toEqual(['one']);
  });

  it('joins multi-line data fields', async () => {
    const frames = await collect(readSSEFrames(stream('data: a\ndata: b\n\n')));
    expect(frames[0]?.data).toBe('a\nb');
  });

  it('captures event and id fields', async () => {
    const frames = await collect(readSSEFrames(stream('event: ping\nid: 7\ndata: x\n\n')));
    expect(frames[0]).toMatchObject({ event: 'ping', id: '7', data: 'x' });
  });

  it('ignores comment keep-alives', async () => {
    const frames = await collect(readSSEFrames(stream(': keep-alive\n\ndata: real\n\n')));
    expect(frames.map((f) => f.data)).toEqual(['real']);
  });

  it('strips exactly one leading space after the colon', async () => {
    const frames = await collect(readSSEFrames(stream('data:  two-spaces\n\n')));
    expect(frames[0]?.data).toBe(' two-spaces');
  });

  it('emits a trailing frame that was never blank-line terminated', async () => {
    const frames = await collect(readSSEFrames(stream('data: last\n')));
    expect(frames.map((f) => f.data)).toEqual(['last']);
  });

  it('survives a multi-byte character split across chunks', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: héllo\n\n');
    const split = 8; // lands inside the two-byte é
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const frames = await collect(readSSEFrames(chunked));
    expect(frames[0]?.data).toBe('héllo');
  });
});

describe('streamSSE', () => {
  it('yields decoded JSON events', async () => {
    const events = await collect(
      streamSSE<{ n: number }>(sseResponse('data: {"n":1}\n\ndata: {"n":2}\n\n')),
    );
    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('treats [DONE] as end-of-stream rather than a decode failure', async () => {
    const events = await collect(
      streamSSE<{ n: number }>(sseResponse('data: {"n":1}\n\ndata: [DONE]\n\n')),
    );
    expect(events).toEqual([{ n: 1 }]);
  });

  it('reports undecodable payloads instead of yielding garbage', async () => {
    await expect(collect(streamSSE(sseResponse('data: {not json\n\n')))).rejects.toBeInstanceOf(
      StreamDecodeError,
    );
  });

  it('yields nothing for an empty body', async () => {
    expect(await collect(streamSSE(new Response(null)))).toEqual([]);
  });
});

describe('streamJSONLines', () => {
  it('yields one event per line', async () => {
    const response = new Response(stream('{"a":1}\n{"a":2}\n'));
    expect(await collect(streamJSONLines<{ a: number }>(response))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('ignores blank lines', async () => {
    const response = new Response(stream('{"a":1}\n\n\n{"a":2}\n'));
    expect(await collect(streamJSONLines<{ a: number }>(response))).toHaveLength(2);
  });
});

describe('event metadata (SPEC.md §3.4.1.2)', () => {
  it('surfaces the retry hint, having previously dropped it', () => {
    // `retry` is the one field only a caller writing their own reconnect loop needs, and the loop is
    // deliberately theirs — so discarding it left resumption impossible rather than merely manual.
    return collect(readSSEFrames(stream('retry: 3000\ndata: one\n\n'))).then((frames) => {
      expect(frames[0]?.retry).toBe(3000);
    });
  });

  it('keeps retry across frames, because it is a connection setting rather than an event field', async () => {
    // The SSE spec makes `retry` govern every later reconnect once sent. Clearing it with the rest of the
    // frame state would report it on the first event and never again, which is the same as not having it.
    const frames = await collect(readSSEFrames(stream('retry: 500\ndata: one\n\ndata: two\n\n')));
    expect(frames.map((frame) => frame.retry)).toEqual([500, 500]);
  });

  it('ignores a retry that is not an integer, as the spec requires', async () => {
    // Not merely invalid: `Number('soon')` is NaN, and a caller passing NaN to `setTimeout` gets a loop
    // that fires immediately and forever rather than an error.
    const frames = await collect(readSSEFrames(stream('retry: soon\ndata: one\n\n')));
    expect(frames[0]?.retry).toBeUndefined();
  });

  it('ignores a negative retry', async () => {
    const frames = await collect(readSSEFrames(stream('retry: -1\ndata: one\n\n')));
    expect(frames[0]?.retry).toBeUndefined();
  });

  it('yields payloads and metadata together, with data typed as the payload', async () => {
    const events = await collect(
      streamSSEEvents<{ n: number }>(
        sseResponse('id: e1\nevent: tick\nretry: 100\ndata: {"n":1}\n\nid: e2\ndata: {"n":2}\n\n'),
      ),
    );
    expect(events).toEqual([
      { data: { n: 1 }, id: 'e1', event: 'tick', retry: 100 },
      { data: { n: 2 }, id: 'e2', event: undefined, retry: 100 },
    ]);
  });

  it('yields the same payloads as the plain iterator', async () => {
    // The two methods must not disagree about what an event *is* — only about how much of the framing
    // comes with it.
    const body = 'id: e1\ndata: {"n":1}\n\ndata: {"n":2}\n\n';
    const plain = await collect(streamSSE<{ n: number }>(sseResponse(body)));
    const withMetadata = await collect(streamSSEEvents<{ n: number }>(sseResponse(body)));
    expect(withMetadata.map((event) => event.data)).toEqual(plain);
  });

  it('reports absent metadata for JSONL, which carries no framing', async () => {
    // The method exists for both encodings so a caller does not have to know which the spec declared.
    const events = await collect(
      streamJSONLineEvents<{ a: number }>(new Response(stream('{"a":1}\n'))),
    );
    expect(events).toEqual([{ data: { a: 1 }, id: undefined, event: undefined, retry: undefined }]);
  });

  it('skips the [DONE] sentinel in the metadata iterator too', async () => {
    const events = await collect(
      streamSSEEvents<{ n: number }>(sseResponse('data: {"n":1}\n\ndata: [DONE]\n\n')),
    );
    expect(events).toHaveLength(1);
  });
});
