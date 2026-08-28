<?php

declare(strict_types=1);

namespace Besdk\Runtime;

final class RateLimitError extends ApiError
{
    /**
     * @param array<string,string> $headers
     */
    public function __construct(
        int $status,
        string $message,
        ?string $requestId = null,
        mixed $body = null,
        array $headers = [],
        public readonly ?float $retryAfterSeconds = null,
    ) {
        parent::__construct($status, $message, $requestId, $body, $headers);
    }
}
