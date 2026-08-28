<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/** Configuration for an OAuth2 token source (SPEC.md §3.1.6). */
final class OAuth2Config
{
    /**
     * @param list<string> $scopes
     */
    public function __construct(
        public readonly string $tokenUrl,
        public readonly ?string $clientId = null,
        public readonly ?string $clientSecret = null,
        public readonly ?string $refreshToken = null,
        public readonly array $scopes = [],
    ) {}
}
