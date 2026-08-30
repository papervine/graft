<?php

declare(strict_types=1);

namespace Graft\Runtime;

final class BearerAuth implements Auth
{
    public function __construct(private readonly string $token) {}

    public function apply(array $headers, array $query): array
    {
        $headers['Authorization'] = 'Bearer ' . $this->token;

        return [$headers, $query];
    }
}
