<?php

declare(strict_types=1);

namespace Besdk\Runtime\Tests;

use Besdk\Runtime\ConnectionError;
use Besdk\Runtime\HttpRequest;
use Besdk\Runtime\HttpResponse;
use Besdk\Runtime\Transport;

/**
 * A transport that replays scripted responses and records what it was asked to send.
 *
 * The existence of this class is the point of `Transport` being an interface: without it, testing code
 * that uses a generated SDK means making real network calls.
 */
final class FakeTransport implements Transport
{
    /** @var list<HttpRequest> */
    public array $requests = [];

    /**
     * @param list<HttpResponse|ConnectionError> $script consumed in order; the last entry repeats
     */
    public function __construct(private array $script) {}

    public function send(HttpRequest $request, float $timeout): HttpResponse
    {
        $this->requests[] = $request;
        $next = count($this->script) > 1 ? array_shift($this->script) : ($this->script[0] ?? null);
        if ($next instanceof ConnectionError) {
            throw $next;
        }
        if (!$next instanceof HttpResponse) {
            throw new \LogicException('FakeTransport ran out of scripted responses');
        }

        return $next;
    }

    /**
     * @param array<string,mixed>  $body
     * @param array<string,string> $headers
     */
    public static function json(int $status, array $body, array $headers = []): HttpResponse
    {
        return new HttpResponse(
            $status,
            json_encode($body, \JSON_THROW_ON_ERROR),
            ['content-type' => 'application/json'] + $headers,
        );
    }

    /**
     * @param list<mixed>          $items
     * @param array<string,string> $headers
     */
    public static function jsonList(int $status, array $items, array $headers = []): HttpResponse
    {
        return new HttpResponse(
            $status,
            json_encode($items, \JSON_THROW_ON_ERROR),
            ['content-type' => 'application/json'] + $headers,
        );
    }
}
