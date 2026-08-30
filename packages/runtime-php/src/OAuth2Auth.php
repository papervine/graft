<?php

declare(strict_types=1);

namespace Graft\Runtime;

/** OAuth2, holding a token source that refreshes itself. */
final class OAuth2Auth implements Auth
{
    public function __construct(private readonly TokenSource $source) {}

    public function apply(array $headers, array $query): array
    {
        $headers['Authorization'] = 'Bearer ' . $this->source->token();

        return [$headers, $query];
    }

    public function invalidate(): void
    {
        $this->source->invalidate();
    }
}
