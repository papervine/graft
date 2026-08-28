<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/** Per-call overrides. */
final class RequestOptions
{
    /**
     * @param array<string,string> $headers
     * @param ?string $idempotencyKey makes a POST or PATCH safe to retry; see Client::replayable()
     */
    public function __construct(
        public readonly ?float $timeout = null,
        public readonly ?int $maxRetries = null,
        public readonly array $headers = [],
        public readonly ?string $idempotencyKey = null,
    ) {}
}
