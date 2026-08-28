/**
 * Pagination.
 *
 * The idiomatic TypeScript answer is `AsyncIterable`, so `for await (const item of …)` just
 * works. But callers also legitimately want one page at a time, so a page object is exposed
 * too, and both come from the same object rather than from two different methods.
 *
 * The shape deliberately mirrors what `fetch`-era TypeScript developers already know: awaiting
 * the returned value gives you the first page; iterating it walks every item.
 */

import { parseTotalCount, valueAtPath } from './coerce.js';
import type { RawResponse } from './client.js';

/** Where a piece of pagination metadata lives on the wire. Mirrors the IR's `ValueSource`. */
export type ValueSource =
  | { readonly kind: 'root' }
  | { readonly kind: 'header'; readonly name: string }
  | { readonly kind: 'body'; readonly path: readonly string[] };

export interface OffsetPaginationConfig {
  readonly style: 'offset';
  readonly limitParam?: string;
  readonly offsetParam?: string;
  readonly totalSource?: ValueSource;
  readonly itemsSource: ValueSource;
}

export interface PagePaginationConfig {
  readonly style: 'page';
  readonly limitParam?: string;
  readonly pageParam?: string;
  readonly totalSource?: ValueSource;
  readonly itemsSource: ValueSource;
}

export interface CursorPaginationConfig {
  readonly style: 'cursor';
  readonly limitParam?: string;
  readonly cursorParam?: string;
  readonly cursorSource?: ValueSource;
  readonly itemsSource: ValueSource;
}

export type PaginationConfig =
  | OffsetPaginationConfig
  | PagePaginationConfig
  | CursorPaginationConfig;

/** Fetches one page given the paging parameters to send. */
export type PageFetcher<TItem> = (
  params: Record<string, string | number>,
) => Promise<RawResponse<unknown>>;

function readItems<TItem>(source: ValueSource, raw: RawResponse<unknown>): TItem[] {
  const value = source.kind === 'root' ? raw.data : source.kind === 'body' ? valueAtPath(raw.data, source.path) : undefined;
  if (Array.isArray(value)) return value as TItem[];
  // A page that is not an array means the response did not match what the IR declared. Treat it
  // as empty rather than throwing: one odd page should end iteration, not crash the caller.
  return [];
}

function readTotal(source: ValueSource | undefined, raw: RawResponse<unknown>): number | undefined {
  if (source === undefined) return undefined;
  if (source.kind === 'header') return parseTotalCount(raw.response.headers.get(source.name));
  if (source.kind === 'body') {
    const value = valueAtPath(raw.data, source.path);
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

function readCursor(source: ValueSource | undefined, raw: RawResponse<unknown>): string | undefined {
  if (source === undefined) return undefined;
  if (source.kind === 'header') return raw.response.headers.get(source.name) ?? undefined;
  if (source.kind === 'body') {
    const value = valueAtPath(raw.data, source.path);
    return typeof value === 'string' && value !== '' ? value : undefined;
  }
  return undefined;
}

/** One page of results. */
export class Page<TItem> {
  constructor(
    readonly items: TItem[],
    /** Total records across all pages, when the API reports one. */
    readonly total: number | undefined,
    /** Whether another page exists. */
    readonly hasNextPage: boolean,
    private readonly fetchNext: (() => Promise<Page<TItem>>) | undefined,
  ) {}

  /** The next page, or `undefined` when this is the last one. */
  async nextPage(): Promise<Page<TItem> | undefined> {
    return this.fetchNext === undefined ? undefined : this.fetchNext();
  }

  /** Iterate this page's items only. Use the paginator itself to cross page boundaries. */
  [Symbol.iterator](): Iterator<TItem> {
    return this.items[Symbol.iterator]();
  }
}

/**
 * A lazy, auto-paging result set.
 *
 * `await` it for the first page; `for await` it to walk every item across pages. Nothing is
 * requested until one of those happens, so building a paginator is free.
 */
export class Paginator<TItem> implements AsyncIterable<TItem>, PromiseLike<Page<TItem>> {
  constructor(
    private readonly config: PaginationConfig,
    private readonly fetchPage: PageFetcher<TItem>,
    /** Paging params the caller already supplied, e.g. an explicit `limit`. */
    private readonly initialParams: Record<string, string | number> = {},
    /**
     * Applied to each page's items — validation and date coercion.
     *
     * Passed in as a callback rather than by handing the Paginator a schema, so this class stays
     * ignorant of descriptors. It exists because paginated methods call `requestRaw` directly and
     * therefore bypassed `requestValidated` entirely: **every paginated response went unchecked and
     * uncoerced** from the moment validation shipped. A list method is the most common thing in an
     * SDK, so that was most of the surface.
     */
    private readonly transformItems?: (items: TItem[]) => TItem[],
  ) {}

  /** Fetch the first page. */
  async firstPage(): Promise<Page<TItem>> {
    return this.pageAt(this.initialParams, 0);
  }

  /** Makes `await client.assets.list()` yield the first page. */
  then<TResult1 = Page<TItem>, TResult2 = never>(
    onfulfilled?: ((value: Page<TItem>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.firstPage().then(onfulfilled, onrejected);
  }

  /** Walk every item across every page. */
  async *[Symbol.asyncIterator](): AsyncIterator<TItem> {
    let page = await this.firstPage();
    while (true) {
      for (const item of page.items) yield item;
      const next = await page.nextPage();
      if (next === undefined) return;
      page = next;
    }
  }

  /** Walk pages rather than items, when you need the page envelope. */
  async *pages(): AsyncGenerator<Page<TItem>> {
    let page: Page<TItem> | undefined = await this.firstPage();
    while (page !== undefined) {
      yield page;
      page = await page.nextPage();
    }
  }

  /** Collect every item. Convenient, and honest about being unbounded. */
  async all(): Promise<TItem[]> {
    const items: TItem[] = [];
    for await (const item of this) items.push(item);
    return items;
  }

  private async pageAt(
    params: Record<string, string | number>,
    consumed: number,
    cursor?: string,
  ): Promise<Page<TItem>> {
    const raw = await this.fetchPage(params);
    const decoded = readItems<TItem>(this.config.itemsSource, raw);
    const items = this.transformItems === undefined ? decoded : this.transformItems(decoded);
    const total = 'totalSource' in this.config ? readTotal(this.config.totalSource, raw) : undefined;
    const seen = consumed + items.length;

    const next = this.nextParams(params, items, seen, total, raw, cursor);
    return new Page(
      items,
      total,
      next !== undefined,
      next === undefined ? undefined : () => this.pageAt(next.params, seen, next.cursor),
    );
  }

  /**
   * Work out the parameters for the following page, or `undefined` if there isn't one.
   *
   * The termination conditions matter more than the increment: a paginator that cannot decide
   * it is finished loops forever against a server that keeps returning the same page.
   */
  private nextParams(
    params: Record<string, string | number>,
    items: readonly TItem[],
    seen: number,
    total: number | undefined,
    raw: RawResponse<unknown>,
    _cursor?: string,
  ): { params: Record<string, string | number>; cursor?: string } | undefined {
    // An empty page always ends iteration, whatever the metadata claims.
    if (items.length === 0) return undefined;

    if (this.config.style === 'cursor') {
      const nextCursor = readCursor(this.config.cursorSource, raw);
      if (nextCursor === undefined || this.config.cursorParam === undefined) return undefined;
      return {
        params: { ...params, [this.config.cursorParam]: nextCursor },
        cursor: nextCursor,
      };
    }

    // A known total is the most reliable stop signal.
    if (total !== undefined && seen >= total) return undefined;

    const limitParam = this.config.limitParam;
    const limit = limitParam !== undefined ? Number(params[limitParam]) : undefined;
    // A short page means the end, provided we know what a full page was.
    if (limit !== undefined && Number.isFinite(limit) && items.length < limit) return undefined;
    // Without a limit or a total there is no way to know a next page exists. Stop rather than
    // request the same page forever.
    if (limit === undefined || !Number.isFinite(limit)) {
      return total !== undefined && seen < total
        ? { params: { ...params, ...this.advance(seen) } }
        : undefined;
    }

    return { params: { ...params, ...this.advance(seen) } };
  }

  private advance(seen: number): Record<string, string | number> {
    if (this.config.style === 'offset') {
      return this.config.offsetParam === undefined ? {} : { [this.config.offsetParam]: seen };
    }
    if (this.config.style === 'page') {
      if (this.config.pageParam === undefined) return {};
      const limitParam = this.config.limitParam;
      const size = limitParam === undefined ? undefined : Number(this.initialParams[limitParam]);
      const perPage = size !== undefined && Number.isFinite(size) && size > 0 ? size : seen;
      return { [this.config.pageParam]: Math.floor(seen / perPage) + 1 };
    }
    return {};
  }
}

/**
 * Drop `undefined` entries from paging parameters.
 *
 * Generated code seeds a paginator from an optional params object, and a key present with value
 * `undefined` is not the same as an absent key — the paginator inspects `params[limitParam]` to
 * decide whether it can detect a short page.
 */
export function pageParams(
  input: Record<string, string | number | undefined>,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
