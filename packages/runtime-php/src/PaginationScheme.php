<?php

declare(strict_types=1);

namespace Graft\Runtime;

/**
 * How a paginated operation advances.
 *
 * Data rather than three subclasses: the differences between offset, page, and cursor paging are entirely
 * in which parameter changes and where the next value comes from.
 */
final class PaginationScheme
{
    /**
     * @param 'offset'|'page'|'cursor' $style
     * @param ?list<string>            $itemsPath   dotted path to the items, or null for a bare array
     * @param ?list<string>            $cursorPath  where the next cursor lives in the body
     * @param ?string                  $totalHeader response header carrying the total count
     * @param ?list<string>            $totalPath   body path carrying the total count
     */
    public function __construct(
        public readonly string $style,
        public readonly ?array $itemsPath = null,
        public readonly ?string $limitParam = null,
        public readonly ?string $offsetParam = null,
        public readonly ?string $pageParam = null,
        public readonly ?string $cursorParam = null,
        public readonly ?array $cursorPath = null,
        public readonly ?string $totalHeader = null,
        public readonly ?array $totalPath = null,
    ) {}
}
