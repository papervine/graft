<?php

declare(strict_types=1);

namespace Graft\Runtime;

/**
 * Walks every page of a paginated operation.
 *
 * `IteratorAggregate` so `foreach ($client->widgets->list() as $widget)` works, which is what a PHP
 * developer expects — the same reasoning that makes it an `AsyncIterable` in TypeScript and a generator in
 * Python. `pages()` and `all()` exist for the cases where per-page access or a materialised array is what
 * the caller actually wants.
 *
 * @template T
 * @implements \IteratorAggregate<int,T>
 */
final class Paginator implements \IteratorAggregate
{
    /** @var ?Page<T> */
    private ?Page $firstPage = null;

    /**
     * @param \Closure(array<string,mixed>): array{0: mixed, 1: HttpResponse} $fetch
     * @param array<string,mixed>                                            $params
     * @param ?\Closure(mixed): list<T>                                      $decode
     */
    public function __construct(
        private readonly PaginationScheme $scheme,
        private readonly \Closure $fetch,
        private readonly array $params = [],
        private readonly ?\Closure $decode = null,
    ) {}

    /**
     * @return \Generator<int,T>
     */
    public function getIterator(): \Generator
    {
        foreach ($this->pages() as $page) {
            foreach ($page->items as $item) {
                yield $item;
            }
        }
    }

    /**
     * @return \Generator<int,Page<T>>
     */
    public function pages(): \Generator
    {
        $params = $this->params;
        $seenCursors = [];

        while (true) {
            [$body, $response] = ($this->fetch)($params);
            $page = $this->pageFrom($body, $response);
            yield $page;

            // An empty page ends the walk regardless of what the scheme says. A server that keeps
            // answering with `[]` and a next cursor would otherwise loop forever.
            if ($page->items === []) {
                return;
            }

            if ($this->scheme->style === 'cursor') {
                $cursor = $this->pathValue($body, $this->scheme->cursorPath);
                if (!is_string($cursor) || $cursor === '') {
                    return;
                }
                // A server echoing the same cursor is a bug, but it is *our* infinite loop, so it is
                // detected here rather than left to the caller's timeout.
                if (isset($seenCursors[$cursor])) {
                    return;
                }
                $seenCursors[$cursor] = true;
                $params[$this->scheme->cursorParam ?? 'cursor'] = $cursor;
                continue;
            }

            if ($this->scheme->style === 'page') {
                $key = $this->scheme->pageParam ?? 'page';
                $current = $params[$key] ?? 1;
                $params[$key] = (is_numeric($current) ? (int) $current : 1) + 1;
                continue;
            }

            $key = $this->scheme->offsetParam ?? 'offset';
            $current = $params[$key] ?? 0;
            $params[$key] = (is_numeric($current) ? (int) $current : 0) + count($page->items);
        }
    }

    /**
     * The first page, without walking the rest.
     *
     * Memoised, so `firstPage()` after iterating does not re-request. The first call is the only one that
     * costs anything.
     *
     * @return Page<T>
     */
    public function firstPage(): Page
    {
        if ($this->firstPage === null) {
            foreach ($this->pages() as $page) {
                $this->firstPage = $page;
                break;
            }
        }

        /** @var Page<T> */
        return $this->firstPage ?? new Page([]);
    }

    /**
     * Every item, materialised.
     *
     * @return list<T>
     */
    public function all(): array
    {
        return iterator_to_array($this->getIterator(), false);
    }

    /**
     * @return Page<T>
     */
    private function pageFrom(mixed $body, HttpResponse $response): Page
    {
        $raw = $this->scheme->itemsPath === null ? $body : $this->pathValue($body, $this->scheme->itemsPath);
        $items = is_array($raw) && array_is_list($raw) ? $raw : [];
        /** @var list<T> $decoded */
        $decoded = $this->decode !== null ? ($this->decode)($items) : $items;

        $total = null;
        if ($this->scheme->totalHeader !== null) {
            $header = $response->header($this->scheme->totalHeader);
            // `X-Content-Range: items 0-49/227` — the total is after the slash, and a bare integer is also
            // in use. Both are read rather than one being declared correct.
            if (is_string($header)) {
                $total = str_contains($header, '/')
                    ? (int) substr($header, strrpos($header, '/') + 1)
                    : (is_numeric($header) ? (int) $header : null);
            }
        } elseif ($this->scheme->totalPath !== null) {
            $value = $this->pathValue($body, $this->scheme->totalPath);
            $total = is_numeric($value) ? (int) $value : null;
        }

        $hasNext = $this->scheme->style === 'cursor'
            ? is_string($this->pathValue($body, $this->scheme->cursorPath))
            : $items !== [];

        return new Page($decoded, $total, $hasNext);
    }

    /**
     * @param ?list<string> $path
     */
    private function pathValue(mixed $body, ?array $path): mixed
    {
        if ($path === null) {
            return null;
        }
        $node = $body;
        foreach ($path as $segment) {
            if (!is_array($node) || !array_key_exists($segment, $node)) {
                return null;
            }
            $node = $node[$segment];
        }

        return $node;
    }
}
