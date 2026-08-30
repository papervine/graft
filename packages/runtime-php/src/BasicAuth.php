<?php

declare(strict_types=1);

namespace Graft\Runtime;

final class BasicAuth implements Auth
{
    public function __construct(
        private readonly string $username,
        private readonly string $password,
    ) {}

    public function apply(array $headers, array $query): array
    {
        $headers['Authorization'] = 'Basic ' . base64_encode($this->username . ':' . $this->password);

        return [$headers, $query];
    }
}
