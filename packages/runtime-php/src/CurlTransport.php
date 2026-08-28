<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/**
 * cURL, which ships with PHP.
 *
 * Deliberately the default so a generated SDK has no required Composer dependency beyond the standard
 * extensions.
 */
final class CurlTransport implements Transport
{
    public function send(HttpRequest $request, float $timeout): HttpResponse
    {
        $handle = curl_init();
        if ($handle === false) {
            throw new ConnectionError('could not initialise cURL');
        }

        // Guarded here rather than typed `non-empty-string` all the way up: that annotation is viral and
        // would reach generated code, and cURL is the only place the invariant is actually needed.
        $method = strtoupper($request->method);
        $url = $request->url;
        if ($method === '' || $url === '') {
            throw new ConnectionError('request has no method or URL');
        }

        $headers = [];
        foreach ($request->headers as $name => $value) {
            $headers[] = $name . ': ' . $value;
        }

        curl_setopt_array($handle, [
            \CURLOPT_URL => $url,
            \CURLOPT_CUSTOMREQUEST => $method,
            \CURLOPT_HTTPHEADER => $headers,
            \CURLOPT_RETURNTRANSFER => true,
            // Milliseconds, so a sub-second timeout is expressible. CURLOPT_TIMEOUT truncates to whole
            // seconds, which would silently turn 0.5 into no timeout at all.
            \CURLOPT_TIMEOUT_MS => (int) round($timeout * 1000),
            \CURLOPT_HEADER => true,
            \CURLOPT_FOLLOWLOCATION => false,
        ]);
        if ($request->body !== null) {
            curl_setopt($handle, \CURLOPT_POSTFIELDS, $request->body);
        }

        $raw = curl_exec($handle);
        if ($raw === false || !is_string($raw)) {
            $message = curl_error($handle);
            $errno = curl_errno($handle);
            curl_close($handle);
            // Distinguished because a timeout is retryable in a way a TLS failure is not.
            if ($errno === \CURLE_OPERATION_TIMEDOUT) {
                throw new TimeoutError($message === '' ? 'request timed out' : $message);
            }
            throw new ConnectionError($message === '' ? 'request failed' : $message);
        }

        $status = (int) curl_getinfo($handle, \CURLINFO_RESPONSE_CODE);
        $headerSize = (int) curl_getinfo($handle, \CURLINFO_HEADER_SIZE);
        curl_close($handle);

        return new HttpResponse(
            $status,
            substr($raw, $headerSize),
            self::parseHeaders(substr($raw, 0, $headerSize)),
        );
    }

    /**
     * @return array<string,string>
     */
    private static function parseHeaders(string $block): array
    {
        $headers = [];
        foreach (explode("\r\n", $block) as $line) {
            $colon = strpos($line, ':');
            if ($colon === false) {
                continue;
            }
            // Lowercased on the way in, so `header()` needs no case-insensitive scan per lookup and
            // HTTP/2's lowercase names and HTTP/1.1's mixed case land in the same place.
            $headers[strtolower(trim(substr($line, 0, $colon)))] = trim(substr($line, $colon + 1));
        }

        return $headers;
    }
}
