<?php

declare(strict_types=1);

namespace Graft\Runtime\Tests;

use Graft\Runtime\ApiError;
use Graft\Runtime\BearerAuth;
use Graft\Runtime\Client;
use Graft\Runtime\ConnectionError;
use Graft\Runtime\DecodeError;
use Graft\Runtime\HttpResponse;
use Graft\Runtime\InternalServerError;
use Graft\Runtime\NotFoundError;
use Graft\Runtime\RateLimitError;
use Graft\Runtime\RequestOptions;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ClientTest extends TestCase
{
    /** No sleeping in tests: the backoff is exercised, the wall clock is not. */
    private function client(FakeTransport $transport, int $maxRetries = 2): Client
    {
        return new Client(
            baseUrl: 'https://api.test',
            auth: new BearerAuth('t'),
            timeout: 5.0,
            maxRetries: $maxRetries,
            transport: $transport,
            sleeper: static function (float $seconds): void {},
        );
    }

    public function testSendsAuthAndDefaultHeaders(): void
    {
        $transport = new FakeTransport([FakeTransport::json(200, ['ok' => true])]);
        $this->client($transport)->request('GET', '/things');

        $request = $transport->requests[0];
        self::assertSame('Bearer t', $request->headers['Authorization']);
        self::assertSame('application/json', $request->headers['Accept']);
        self::assertSame('https://api.test/things', $request->url);
    }

    public function testMapsStatusesToTypedErrors(): void
    {
        $transport = new FakeTransport([FakeTransport::json(404, ['message' => 'no such thing'])]);
        try {
            $this->client($transport)->request('GET', '/things/x');
            self::fail('expected NotFoundError');
        } catch (NotFoundError $error) {
            self::assertSame(404, $error->status);
            // The server's own words, with no status prefix — the cross-language suite pins this.
            self::assertSame('no such thing', $error->getMessage());
        }
    }

    public function testReadsRetryAfterOnRateLimit(): void
    {
        $transport = new FakeTransport([
            new HttpResponse(429, '{"message":"slow down"}', ['content-type' => 'application/json', 'retry-after' => '2']),
        ]);
        try {
            $this->client($transport, maxRetries: 0)->request('GET', '/things');
            self::fail('expected RateLimitError');
        } catch (RateLimitError $error) {
            self::assertSame(2.0, $error->retryAfterSeconds);
        }
    }

    // --- retry safety by method (SPEC.md §3.4.0.1) ---------------------------

    /**
     * @return list<array{0: string}>
     */
    public static function idempotentMethods(): array
    {
        return [['GET'], ['HEAD'], ['PUT'], ['DELETE'], ['OPTIONS']];
    }

    #[DataProvider('idempotentMethods')]
    public function testRetriesMethodsHttpDefinesAsIdempotent(string $method): void
    {
        $transport = new FakeTransport([FakeTransport::json(503, ['message' => 'later'])]);
        try {
            $this->client($transport)->request($method, '/things');
        } catch (InternalServerError) {
            // Expected after exhausting retries.
        }
        self::assertCount(3, $transport->requests, "{$method} should be retried");
    }

    public function testDoesNotRetryPostWithoutAnIdempotencyKey(): void
    {
        // The bug this pins: a `POST /charges` returning 503 was sent three times, and whether the server
        // processed the first is unknowable from here. The plausible outcome was three charges.
        $transport = new FakeTransport([FakeTransport::json(503, ['message' => 'later'])]);
        try {
            $this->client($transport)->request('POST', '/charges', body: '{}');
        } catch (InternalServerError) {
        }
        self::assertCount(1, $transport->requests);
    }

    public function testRetriesPostWithAnIdempotencyKey(): void
    {
        $transport = new FakeTransport([FakeTransport::json(503, ['message' => 'later'])]);
        try {
            $this->client($transport)->request(
                'POST',
                '/charges',
                body: '{}',
                options: new RequestOptions(idempotencyKey: 'req_1'),
            );
        } catch (InternalServerError) {
        }
        self::assertCount(3, $transport->requests);
        // Deduplication happens on the server, so the key must be identical on every attempt.
        foreach ($transport->requests as $request) {
            self::assertSame('req_1', $request->headers[Client::DEFAULT_IDEMPOTENCY_HEADER]);
            self::assertSame('{}', $request->body);
        }
    }

    public function testDoesNotRetryA400EvenWithAKey(): void
    {
        // A 400 was understood and rejected. Resending it is pure load on someone else's service.
        $transport = new FakeTransport([FakeTransport::json(400, ['message' => 'bad'])]);
        try {
            $this->client($transport)->request('POST', '/things', options: new RequestOptions(idempotencyKey: 'k'));
        } catch (ApiError) {
        }
        self::assertCount(1, $transport->requests);
    }

    public function testRetriesAConnectionFailureRegardlessOfMethod(): void
    {
        // A request that never completed left no side effect, so replaying it is safe even for POST —
        // the one retry case an idempotency key does not gate.
        $transport = new FakeTransport([new ConnectionError('reset')]);
        try {
            $this->client($transport)->request('POST', '/things', body: '{}');
        } catch (ConnectionError) {
        }
        self::assertCount(3, $transport->requests);
    }

    public function testHonoursAConfiguredIdempotencyHeader(): void
    {
        $transport = new FakeTransport([FakeTransport::json(200, [])]);
        $client = new Client(
            baseUrl: 'https://api.test',
            transport: $transport,
            idempotencyHeader: 'X-Idempotency-Key',
            sleeper: static function (float $s): void {},
        );
        $client->request('POST', '/things', options: new RequestOptions(idempotencyKey: 'k'));
        self::assertSame('k', $transport->requests[0]->headers['X-Idempotency-Key']);
    }

    public function testClampsANegativeRetryCount(): void
    {
        // -1 made the Python retry loop run zero times, so every request failed with "no recorded error".
        $transport = new FakeTransport([FakeTransport::json(200, ['ok' => true])]);
        $client = new Client(baseUrl: 'https://api.test', maxRetries: -1, transport: $transport);
        $client->request('GET', '/things');
        self::assertCount(1, $transport->requests);
    }

    public function testReportsInvalidJsonAsADecodeError(): void
    {
        $transport = new FakeTransport([new HttpResponse(200, 'not json', ['content-type' => 'application/json'])]);
        $this->expectException(DecodeError::class);
        $this->client($transport)->requestJson('GET', '/things');
    }

    public function testTreatsAnEmptyBodyAsNull(): void
    {
        $transport = new FakeTransport([new HttpResponse(204, '', [])]);
        self::assertNull($this->client($transport)->requestJson('DELETE', '/things/x'));
    }
}
