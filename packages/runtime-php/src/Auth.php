<?php

declare(strict_types=1);

namespace Graft\Runtime;

/** How a request proves who is making it. */
interface Auth
{
    /**
     * @param  array<string,string>       $headers
     * @param  array<string,list<string>> $query
     * @return array{0: array<string,string>, 1: array<string,list<string>>}
     */
    public function apply(array $headers, array $query): array;
}
