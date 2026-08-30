<?php

declare(strict_types=1);

namespace Graft\Runtime;

/**
 * The transport every generated resource calls into.
 *
 * Hand-written, and the reason generated code stays thin (`AGENTS.md`). Everything here is shared by every
 * operation in every SDK this target produces, so it is worth reading rather than generating.
 */
class Client
{
    /**
     * Methods safe to replay without an idempotency key, per HTTP's own definition.
     *
     * `DELETE` is included deliberately: a second delete returning 404 is a *correct* outcome, not a
     * failure. `POST` and `PATCH` are absent — see {@see replayable()} (SPEC.md §3.4.0.1).
     */
    private const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'];

    /** Not standardised — `X-Idempotency-Key` and `Idempotency-Token` are also in real use. */
    public const DEFAULT_IDEMPOTENCY_HEADER = 'Idempotency-Key';

    private readonly Transport $transport;

    private readonly int $maxRetries;

    /**
     * @param array<string,string> $defaultHeaders
     */
    public function __construct(
        private readonly string $baseUrl,
        private readonly Auth $auth = new NoAuth(),
        private readonly float $timeout = 60.0,
        int $maxRetries = 2,
        private readonly array $defaultHeaders = [],
        ?Transport $transport = null,
        // Role-named, never brand-named: a user agent travels in a consumer's HTTP traffic, so the
        // generator's name there would make renaming this project a visible change for every SDK it
        // produced. Generated clients pass their own `<ClientName>/<version> php` and never see this.
        private readonly string $userAgent = 'sdk-php',
        private readonly ValidationMode $validation = ValidationMode::Strict,
        private readonly string $idempotencyHeader = self::DEFAULT_IDEMPOTENCY_HEADER,
        /** Injected so a retry test does not actually sleep. */
        private readonly ?\Closure $sleeper = null,
    ) {
        // Clamped rather than trusted: a negative value made the Python retry loop run zero times, so
        // every request failed with "no recorded error" (SPEC.md §3.3.3).
        $this->maxRetries = max(0, $maxRetries);
        $this->transport = $transport ?? new CurlTransport();
    }

    public function validationMode(): ValidationMode
    {
        return $this->validation;
    }

    public function baseUrl(): string
    {
        return $this->baseUrl;
    }

    /**
     * Send a request, retrying what is safe to retry.
     *
     * @param array<string,mixed> $query
     */
    public function request(
        string $method,
        string $path,
        array $query = [],
        ?string $body = null,
        ?RequestOptions $options = null,
        string $contentType = 'application/json',
    ): HttpResponse {
        $method = strtoupper($method);
        [$headers, $flatQuery] = $this->auth->apply(
            $this->headersFor($body, $options, $contentType),
            Query::flatten($query),
        );
        $request = new HttpRequest(
            $method,
            Query::url($this->baseUrl, $path, $flatQuery),
            $headers,
            $body,
            $flatQuery,
        );

        $attempts = ($options->maxRetries ?? $this->maxRetries) + 1;
        $timeout = $options->timeout ?? $this->timeout;
        $refreshed = false;
        $lastError = null;

        for ($attempt = 1; $attempt <= $attempts; $attempt++) {
            try {
                $response = $this->transport->send($request, $timeout);
            } catch (ConnectionError $error) {
                // A request that never completed left no side effect, so replaying it is safe regardless
                // of method — this is the one retry case idempotency does not gate.
                $lastError = $error;
                if ($attempt === $attempts) {
                    throw $error;
                }
                $this->backoff($attempt);
                continue;
            }

            if ($response->status < 400) {
                return $response;
            }

            $error = $this->errorFor($response);

            // A 401 buys one forced refresh and one retry: clocks disagree and servers revoke tokens
            // early, so a token this client believes is valid may not be (SPEC.md §3.1.6).
            if ($response->status === 401 && $this->auth instanceof OAuth2Auth && !$refreshed) {
                $refreshed = true;
                $this->auth->invalidate();
                [$headers, $flatQuery] = $this->auth->apply(
                    $this->headersFor($body, $options, $contentType),
                    Query::flatten($query),
                );
                $request = new HttpRequest($method, $request->url, $headers, $body, $flatQuery);
                continue;
            }

            if ($attempt === $attempts || !$this->shouldRetry($response->status, $method, $options)) {
                throw $error;
            }
            $lastError = $error;
            $this->backoff($attempt, $error instanceof RateLimitError ? $error->retryAfterSeconds : null);
        }

        // Unreachable: every path above either returns or throws. Present because PHP cannot prove that,
        // and an implicit `null` return would be a worse failure than an explicit one.
        throw $lastError ?? new ConnectionError('request failed with no recorded error');
    }

    /**
     * Send a request and decode JSON.
     *
     * @param array<string,mixed> $query
     */
    public function requestJson(
        string $method,
        string $path,
        array $query = [],
        ?string $body = null,
        ?RequestOptions $options = null,
        string $contentType = 'application/json',
    ): mixed {
        $response = $this->request($method, $path, $query, $body, $options, $contentType);
        if (trim($response->body) === '') {
            return null;
        }
        try {
            return json_decode($response->body, true, 512, \JSON_THROW_ON_ERROR);
        } catch (\JsonException $error) {
            throw new DecodeError(
                'response was not valid JSON: ' . $error->getMessage(),
                0,
                $error,
            );
        }
    }

    /**
     * Send a request and return both the decoded body and the raw response.
     *
     * The paginator needs both: items come from the body, and a total count may arrive in a header
     * (`X-Content-Range`). Returning only the decoded body would make a header-sourced total unreachable,
     * which is exactly the shape Twilio and several other real specs use.
     *
     * @param  array<string,mixed>              $query
     * @return array{0: mixed, 1: HttpResponse}
     */
    public function requestPage(
        string $method,
        string $path,
        array $query = [],
        ?RequestOptions $options = null,
    ): array {
        $response = $this->request($method, $path, $query, null, $options);
        $body = trim($response->body) === '' ? null : json_decode($response->body, true);

        return [$body, $response];
    }

    /**
     * Whether a failed request may be sent again.
     *
     * Two conditions, and both matter. The status must be one where retrying could plausibly help, *and*
     * the request must be replayable — a `POST` that returned 503 may well have been processed before the
     * failure, so resending it blind is how one call becomes three charges (SPEC.md §3.4.0.1).
     */
    private function shouldRetry(int $status, string $method, ?RequestOptions $options): bool
    {
        return $this->retryableStatus($status) && $this->replayable($method, $options);
    }

    private function retryableStatus(int $status): bool
    {
        // 501 excluded: an unimplemented method stays unimplemented.
        return $status === 408 || $status === 409 || $status === 429 || ($status >= 500 && $status !== 501);
    }

    /**
     * `POST` and `PATCH` are replayable only with an idempotency key, because deduplication has to happen
     * on the server — a client cannot make a replay safe by itself.
     */
    private function replayable(string $method, ?RequestOptions $options): bool
    {
        if (in_array($method, self::IDEMPOTENT_METHODS, true)) {
            return true;
        }

        return $options?->idempotencyKey !== null;
    }

    /**
     * @return array<string,string>
     */
    private function headersFor(?string $body, ?RequestOptions $options, string $contentType): array
    {
        $headers = ['Accept' => 'application/json', 'User-Agent' => $this->userAgent];
        foreach ($this->defaultHeaders as $name => $value) {
            $headers[$name] = $value;
        }
        if ($body !== null) {
            $headers['Content-Type'] = $contentType;
        }
        foreach ($options->headers ?? [] as $name => $value) {
            $headers[$name] = $value;
        }
        if ($options?->idempotencyKey !== null) {
            $headers[$this->idempotencyHeader] = $options->idempotencyKey;
        }

        return $headers;
    }

    /** Full jitter exponential backoff, capped. Prevents synchronised retry storms across clients. */
    private function backoff(int $attempt, ?float $retryAfter = null): void
    {
        $seconds = $retryAfter ?? min(8.0, 0.5 * (2 ** ($attempt - 1))) * (mt_rand(0, 1000) / 1000);
        if ($this->sleeper !== null) {
            ($this->sleeper)($seconds);

            return;
        }
        usleep((int) round($seconds * 1_000_000));
    }

    private function errorFor(HttpResponse $response): ApiError
    {
        /** @var mixed $body */
        $body = trim($response->body) === '' ? null : json_decode($response->body, true);
        $message = 'request failed';
        if (is_array($body)) {
            foreach (['message', 'error', 'detail', 'error_description'] as $key) {
                $candidate = $body[$key] ?? null;
                if (is_string($candidate) && $candidate !== '') {
                    $message = $candidate;
                    break;
                }
            }
        }
        // The server's own words, with no status prefix. Prefixing made the same failure read differently
        // in each language, which the cross-language suite caught (SPEC.md §3.4.2).
        $requestId = $response->header('x-request-id') ?? $response->header('request-id');

        return match (true) {
            $response->status === 400 => new BadRequestError($response->status, $message, $requestId, $body, $response->headers),
            $response->status === 401 => new AuthenticationError($response->status, $message, $requestId, $body, $response->headers),
            $response->status === 403 => new PermissionDeniedError($response->status, $message, $requestId, $body, $response->headers),
            $response->status === 404 => new NotFoundError($response->status, $message, $requestId, $body, $response->headers),
            $response->status === 409 => new ConflictError($response->status, $message, $requestId, $body, $response->headers),
            $response->status === 422 => new UnprocessableEntityError($response->status, $message, $requestId, $body, $response->headers),
            $response->status === 429 => new RateLimitError(
                $response->status,
                $message,
                $requestId,
                $body,
                $response->headers,
                is_numeric($response->header('retry-after')) ? (float) $response->header('retry-after') : null,
            ),
            $response->status >= 500 => new InternalServerError($response->status, $message, $requestId, $body, $response->headers),
            default => new ApiError($response->status, $message, $requestId, $body, $response->headers),
        };
    }
}
