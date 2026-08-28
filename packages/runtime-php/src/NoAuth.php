<?php

declare(strict_types=1);

namespace Besdk\Runtime;

final class NoAuth implements Auth
{
    public function apply(array $headers, array $query): array
    {
        return [$headers, $query];
    }
}
