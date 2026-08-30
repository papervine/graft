<?php

declare(strict_types=1);

namespace Graft\Runtime;

/**
 * An API key, in a header or the query string.
 *
 * The query variant exists because specs declare it, not because it is a good idea — a key in a URL lands
 * in access logs and browser history. graft honours what the spec says and does not editorialise.
 */
final class ApiKeyAuth implements Auth
{
    public function __construct(
        private readonly string $key,
        private readonly string $name,
        private readonly bool $inQuery = false,
    ) {}

    public function apply(array $headers, array $query): array
    {
        if ($this->inQuery) {
            $query[$this->name] = [$this->key];
        } else {
            $headers[$this->name] = $this->key;
        }

        return [$headers, $query];
    }
}
