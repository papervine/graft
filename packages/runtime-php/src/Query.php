<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/**
 * Building query strings and URLs.
 *
 * Its own file because the rules are fiddly and shared: every generated method funnels through them, and
 * getting `null` versus `false` versus `[]` wrong is the kind of bug that only shows up against a real
 * server.
 */
final class Query
{
    /**
     * Flatten user-supplied query parameters into repeated string values.
     *
     * Three rules that each cost a real bug elsewhere:
     *
     * - **`null` is omitted, `false` is not.** `?active=false` is a meaningful filter; `?active=` is a
     *   different request from omitting the parameter entirely, and PHP's `http_build_query` renders
     *   `false` as the empty string, which loses that distinction.
     * - **An array repeats the key.** `?tag=a&tag=b`, not `?tag[0]=a`, which is PHP-specific and rejected
     *   by most servers. This is the mirror of the `phpEmptyMap` artifact (§3.1.2) — PHP's serializer
     *   conventions leaking into wire formats is a recurring theme, and here we are on the emitting side.
     * - **An empty array sends nothing**, rather than an empty key.
     *
     * @param  array<string,mixed>       $params
     * @return array<string,list<string>>
     */
    public static function flatten(array $params): array
    {
        $out = [];
        foreach ($params as $key => $value) {
            if ($value === null) {
                continue;
            }
            $values = is_array($value) ? array_values($value) : [$value];
            $rendered = [];
            foreach ($values as $item) {
                if ($item === null) {
                    continue;
                }
                $rendered[] = self::scalar($item);
            }
            if ($rendered !== []) {
                $out[$key] = $rendered;
            }
        }

        return $out;
    }

    /**
     * One query value as a string.
     *
     * `true`/`false` rather than `1`/`""`, because a server reading a boolean query parameter expects the
     * words. A `DateTimeInterface` becomes RFC 3339, which is what every JSON API means by a timestamp.
     */
    private static function scalar(mixed $value): string
    {
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if ($value instanceof \DateTimeInterface) {
            return $value->format(\DateTimeInterface::RFC3339);
        }
        // Before the object branch, or a generated enum falls through to `json_encode` and arrives on the
        // wire as `"member"` — with literal quotes. The cross-language conformance suite caught this: every
        // other language sent `member`, and no gate or unit test would have noticed.
        if ($value instanceof \BackedEnum) {
            return (string) $value->value;
        }
        if (is_scalar($value)) {
            return (string) $value;
        }
        if ($value instanceof \JsonSerializable || is_object($value) || is_array($value)) {
            // A structured query value has no standard encoding; JSON is the least surprising and is what
            // the other runtimes do.
            return json_encode($value, \JSON_THROW_ON_ERROR | \JSON_UNESCAPED_SLASHES);
        }

        return '';
    }

    /**
     * Join a base URL, a path, and query parameters.
     *
     * @param array<string,list<string>> $query
     */
    public static function url(string $baseUrl, string $path, array $query = []): string
    {
        $url = rtrim($baseUrl, '/') . '/' . ltrim($path, '/');
        if ($query === []) {
            return $url;
        }

        $parts = [];
        foreach ($query as $key => $values) {
            foreach ($values as $value) {
                $parts[] = rawurlencode($key) . '=' . rawurlencode($value);
            }
        }

        return $url . (str_contains($url, '?') ? '&' : '?') . implode('&', $parts);
    }

    /**
     * Substitute `{name}` path parameters.
     *
     * Each value is percent-encoded, so an id containing a slash cannot escape its segment and reach a
     * different endpoint. `rawurlencode` rather than `urlencode`: the latter encodes a space as `+`,
     * which is correct in a query string and wrong in a path.
     *
     * @param array<string,string|int|float> $params
     */
    public static function path(string $template, array $params): string
    {
        $result = $template;
        foreach ($params as $name => $value) {
            $result = str_replace('{' . $name . '}', rawurlencode((string) $value), $result);
        }

        return $result;
    }
}
