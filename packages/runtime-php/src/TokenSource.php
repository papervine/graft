<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/**
 * Fetches and refreshes an OAuth2 access token.
 *
 * **No single-flight lock, and that is a language difference rather than an omission.** PHP's default
 * execution model is one request per process with no shared memory, so the concurrent-refresh problem the
 * TypeScript, Python, and Go runtimes each solve — two threads discovering an expired token at once and
 * both refreshing — cannot arise. Under a persistent worker (Swoole, FrankenPHP) a token source is still
 * per-instance, so a lock would guard a resource nothing else touches.
 *
 * What *does* carry over is refreshing proactively rather than on failure: waiting for a 401 spends a real
 * request to discover something the expiry time already said.
 */
final class TokenSource
{
    /** Refresh this many seconds before expiry, because clocks disagree and a token in flight can expire. */
    private const EXPIRY_SKEW_SECONDS = 30;

    private ?string $accessToken = null;

    private ?float $expiresAt = null;

    public function __construct(
        private readonly OAuth2Config $config,
        private readonly Transport $transport,
        private readonly float $timeout = 30.0,
        /** Injected so a test can advance time without sleeping. */
        private readonly ?\Closure $clock = null,
    ) {}

    public function token(): string
    {
        $now = $this->now();
        if (
            $this->accessToken !== null
            && $this->expiresAt !== null
            && $now < $this->expiresAt - self::EXPIRY_SKEW_SECONDS
        ) {
            return $this->accessToken;
        }

        return $this->fetch();
    }

    /** Drop the cached token, so the next call fetches a fresh one. Used by the 401-retry path. */
    public function invalidate(): void
    {
        $this->accessToken = null;
        $this->expiresAt = null;
    }

    private function fetch(): string
    {
        $form = $this->config->refreshToken !== null
            ? ['grant_type' => 'refresh_token', 'refresh_token' => $this->config->refreshToken]
            : ['grant_type' => 'client_credentials'];
        if ($this->config->scopes !== []) {
            $form['scope'] = implode(' ', $this->config->scopes);
        }

        $headers = ['Content-Type' => 'application/x-www-form-urlencoded', 'Accept' => 'application/json'];
        // Client credentials go in the Authorization header when both are present — that is the form every
        // provider accepts, where in-body credentials are optional in the spec and unevenly implemented.
        if ($this->config->clientId !== null && $this->config->clientSecret !== null) {
            $headers['Authorization'] = 'Basic ' . base64_encode(
                $this->config->clientId . ':' . $this->config->clientSecret,
            );
        } elseif ($this->config->clientId !== null) {
            $form['client_id'] = $this->config->clientId;
        }

        $response = $this->transport->send(
            new HttpRequest('POST', $this->config->tokenUrl, $headers, http_build_query($form)),
            $this->timeout,
        );

        if ($response->status < 200 || $response->status >= 300) {
            // Never retried: a 400 from a token endpoint means the credentials are wrong, and retrying
            // wrong credentials is how an account gets locked.
            throw new OAuth2Error(sprintf(
                'token request failed with %d: %s',
                $response->status,
                substr($response->body, 0, 500),
            ));
        }

        /** @var mixed $decoded */
        $decoded = json_decode($response->body, true);
        if (!is_array($decoded) || !isset($decoded['access_token']) || !is_string($decoded['access_token'])) {
            throw new OAuth2Error('token response had no string access_token');
        }

        $this->accessToken = $decoded['access_token'];
        $expiresIn = $decoded['expires_in'] ?? null;
        // A provider that omits `expires_in` gets an hour, which is the de facto default. Treating an
        // absent expiry as "never expires" would cache a dead token indefinitely.
        $this->expiresAt = $this->now() + (is_numeric($expiresIn) ? (float) $expiresIn : 3600.0);

        return $this->accessToken;
    }

    private function now(): float
    {
        return $this->clock !== null ? (float) ($this->clock)() : microtime(true);
    }
}
