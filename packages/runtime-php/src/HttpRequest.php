<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/** One HTTP exchange, as this runtime models it. */
final class HttpRequest
{
    /**
     * @param array<string,string>       $headers
     * @param array<string,list<string>> $query already flattened; see Query::flatten()
     */
    public function __construct(
        public readonly string $method,
        public readonly string $url,
        public readonly array $headers = [],
        public readonly ?string $body = null,
        public readonly array $query = [],
    ) {}
}
