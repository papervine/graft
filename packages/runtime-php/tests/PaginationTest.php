<?php

declare(strict_types=1);

namespace Besdk\Runtime\Tests;

use Besdk\Runtime\HttpResponse;
use Besdk\Runtime\PaginationScheme;
use Besdk\Runtime\Paginator;
use PHPUnit\Framework\TestCase;

final class PaginationTest extends TestCase
{
    /**
     * A fetcher plus a record of what it was called with.
     *
     * An object rather than a returned pair: PHP copies an array on destructuring, so `[$fetch, $calls]`
     * captured the call log as it was *before* any call happened — permanently empty. References do not
     * survive that, which is exactly the kind of thing worth failing a test over rather than reasoning
     * about.
     *
     * @param list<array{0: mixed, 1: HttpResponse}> $pages
     */
    private function fetcher(array $pages): Fetcher
    {
        return new Fetcher($pages);
    }

    /**
     * @param  array<string,string>              $headers
     * @return array{0: mixed, 1: HttpResponse}
     */
    private static function ok(mixed $body, array $headers = []): array
    {
        return [$body, new HttpResponse(200, '', $headers)];
    }

    public function testWalksEveryItemAcrossOffsetPages(): void
    {
        $recorder = $this->fetcher([
            self::ok([['id' => 1], ['id' => 2]]),
            self::ok([['id' => 3]]),
            self::ok([]),
        ]);
        $paginator = new Paginator(
            new PaginationScheme('offset', limitParam: 'limit', offsetParam: 'offset'),
            $recorder->fetch(),
            ['limit' => 2],
        );

        $ids = array_map(
            static fn(mixed $item): mixed => is_array($item) ? $item['id'] : null,
            $paginator->all(),
        );
        self::assertSame([1, 2, 3], $ids);
        // The offset advances by the number of items actually returned, not by the requested limit — a
        // server returning a short page must not cause items to be skipped.
        self::assertSame([['limit' => 2], ['limit' => 2, 'offset' => 2], ['limit' => 2, 'offset' => 3]], $recorder->calls);
    }

    public function testStopsOnAnEmptyPage(): void
    {
        $recorder = $this->fetcher([self::ok([]), self::ok([['id' => 1]])]);
        $paginator = new Paginator(new PaginationScheme('offset'), $recorder->fetch());
        self::assertSame([], $paginator->all());
        self::assertCount(1, $recorder->calls);
    }

    public function testFollowsACursorAndStopsWhenItIsAbsent(): void
    {
        $recorder = $this->fetcher([
            self::ok(['items' => [['id' => 1]], 'next' => 'c2']),
            self::ok(['items' => [['id' => 2]]]),
        ]);
        $paginator = new Paginator(
            new PaginationScheme('cursor', itemsPath: ['items'], cursorParam: 'cursor', cursorPath: ['next']),
            $recorder->fetch(),
        );
        self::assertCount(2, $paginator->all());
        self::assertSame(['cursor' => 'c2'], $recorder->calls[1]);
    }

    public function testStopsWhenAServerRepeatsACursor(): void
    {
        // A server echoing the same cursor is its bug, but the infinite loop would be ours.
        $recorder = $this->fetcher([
            self::ok(['items' => [['id' => 1]], 'next' => 'same']),
            self::ok(['items' => [['id' => 2]], 'next' => 'same']),
            self::ok(['items' => [['id' => 3]], 'next' => 'same']),
        ]);
        $paginator = new Paginator(
            new PaginationScheme('cursor', itemsPath: ['items'], cursorParam: 'cursor', cursorPath: ['next']),
            $recorder->fetch(),
        );
        self::assertCount(2, $paginator->all());
    }

    public function testReadsATotalFromAContentRangeHeader(): void
    {
        $recorder = $this->fetcher([self::ok([['id' => 1]], ['x-content-range' => 'items 0-0/227'])]);
        $paginator = new Paginator(
            new PaginationScheme('offset', totalHeader: 'X-Content-Range'),
            $recorder->fetch(),
        );
        self::assertSame(227, $paginator->firstPage()->total);
    }

    public function testReadsABareIntegerTotalHeader(): void
    {
        $recorder = $this->fetcher([self::ok([['id' => 1]], ['x-total-count' => '42'])]);
        $paginator = new Paginator(new PaginationScheme('offset', totalHeader: 'X-Total-Count'), $recorder->fetch());
        self::assertSame(42, $paginator->firstPage()->total);
    }

    public function testFirstPageIsMemoised(): void
    {
        $recorder = $this->fetcher([self::ok([['id' => 1]]), self::ok([])]);
        $paginator = new Paginator(new PaginationScheme('offset'), $recorder->fetch());
        $paginator->firstPage();
        $paginator->firstPage();
        self::assertCount(1, $recorder->calls);
    }

    public function testForeachYieldsItemsDirectly(): void
    {
        // `foreach ($client->widgets->list() as $widget)` is what a PHP developer expects, which is why
        // Paginator is an IteratorAggregate rather than exposing only pages().
        $recorder = $this->fetcher([self::ok([['id' => 1], ['id' => 2]]), self::ok([])]);
        $seen = [];
        foreach (new Paginator(new PaginationScheme('offset'), $recorder->fetch()) as $item) {
            self::assertIsArray($item);
            $seen[] = $item['id'];
        }
        self::assertSame([1, 2], $seen);
    }
}

/**
 * Records the parameters each page request was made with.
 *
 * @internal test support
 */
final class Fetcher
{
    /** @var list<array<string,mixed>> */
    public array $calls = [];

    private int $index = 0;

    /**
     * @param list<array{0: mixed, 1: HttpResponse}> $pages
     */
    public function __construct(private readonly array $pages) {}

    /**
     * @return \Closure(array<string,mixed>): array{0: mixed, 1: HttpResponse}
     */
    public function fetch(): \Closure
    {
        return function (array $params): array {
            $this->calls[] = $params;

            return $this->pages[$this->index++] ?? [[], new HttpResponse(200, '[]')];
        };
    }
}
