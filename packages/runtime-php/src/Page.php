<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/**
 * One page of results.
 *
 * @template T
 */
final class Page
{
    /**
     * @param list<T> $items
     */
    public function __construct(
        public readonly array $items,
        public readonly ?int $total = null,
        public readonly bool $hasNextPage = false,
    ) {}
}
