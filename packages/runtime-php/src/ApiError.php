<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/**
 * The server responded, and said no.
 *
 * Always has a status. Connection failures live on their own branch precisely so this stays true —
 * otherwise every caller reading `$e->status` would need a null check for a case that never carries one.
 */
class ApiError extends SdkError
{
    /**
     * @param array<string,string> $headers
     */
    public function __construct(
        public readonly int $status,
        string $message,
        public readonly ?string $requestId = null,
        public readonly mixed $body = null,
        public readonly array $headers = [],
    ) {
        parent::__construct($message, $status);
    }
}
