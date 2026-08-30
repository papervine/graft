<?php

declare(strict_types=1);

namespace Graft\Runtime;

/**
 * How a request is actually sent.
 *
 * An interface so a caller can inject their own — without it, testing code that uses a generated SDK
 * means making real network calls, which is not a nicety (SPEC.md §3.3.2). A PSR-18 client is adapted to
 * this rather than being the interface itself: making PSR-18 the default would put Composer dependencies
 * and a discovery problem in the way of a hello-world SDK (§3.3.7).
 */
interface Transport
{
    public function send(HttpRequest $request, float $timeout): HttpResponse;
}
