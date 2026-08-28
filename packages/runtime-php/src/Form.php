<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/**
 * Encoding a request body as `application/x-www-form-urlencoded`.
 *
 * Its own file because the rules are shared with nothing else and getting them wrong is invisible: a
 * server receiving JSON where it expected a form rejects the request, and nothing on the client side can
 * tell. Every write operation of every form-based API was sent as JSON before this existed.
 *
 * Routed through the body's *JSON* representation rather than reflected over directly, so the wire names
 * and the omit-when-null rules are exactly the ones the JSON path already gets right. Reflecting
 * separately would be a second implementation of field naming, and the two would disagree the first time
 * a model changed.
 */
final class Form
{
    /**
     * Encode a request body as a form-encoded string.
     *
     * A list becomes a repeated key, which is what every form-encoded API this project has seen expects;
     * `key[]=` is a PHP convention that servers outside PHP do not read, and `key=a,b` is a third — so
     * `http_build_query` is deliberately *not* used for the list case, because it produces `key[0]=`.
     *
     * A nested object is JSON-encoded, matching the multipart path: form encoding has no canonical
     * nesting, and inventing one would send something no server asked for.
     */
    public static function encode(mixed $body): string
    {
        $fields = json_decode(json_encode($body, \JSON_THROW_ON_ERROR) ?: '{}', true);
        if (!is_array($fields)) {
            return '';
        }

        $pairs = [];
        foreach ($fields as $key => $value) {
            // Null is omitted rather than sent as the string `""`, which a server reads as a real empty
            // value — the same rule `Query` follows.
            if ($value === null) {
                continue;
            }
            $name = rawurlencode((string) $key);
            if (is_array($value) && array_is_list($value)) {
                foreach ($value as $item) {
                    if ($item === null) {
                        continue;
                    }
                    $pairs[] = $name . '=' . rawurlencode(self::scalar($item));
                }

                continue;
            }
            $pairs[] = $name . '=' . rawurlencode(self::scalar($value));
        }

        return implode('&', $pairs);
    }

    /**
     * One value as a form field.
     *
     * Shared with `Multipart` through `scalarFor`, so a boolean is `true` in both encodings and an
     * integral float is an integer in both. Two copies of this would disagree, and the disagreement would
     * only show up against a server strict about one of them.
     */
    public static function scalarFor(mixed $value): string
    {
        return self::scalar($value);
    }

    /** One value as a form field. */
    private static function scalar(mixed $value): string
    {
        if (is_bool($value)) {
            // `(string) true` is `"1"`, which some servers read and others do not; `true` is unambiguous
            // and matches what every other runtime here sends.
            return $value ? 'true' : 'false';
        }
        if (is_array($value)) {
            return json_encode($value, \JSON_THROW_ON_ERROR) ?: '';
        }
        if (is_string($value)) {
            return $value;
        }
        if (is_int($value) || is_float($value)) {
            // A float that is integral is written as an integer: `1.0` reaching a server as `1.0` where an
            // id was expected is a rejected request, and PHP's default cast produces exactly that.
            return is_float($value) && $value === floor($value) && abs($value) < 1e15
                ? (string) (int) $value
                : (string) $value;
        }

        // Anything else — an object without JSON serialisation, a resource — has no faithful form
        // representation, and guessing at one would send something the server cannot read.
        return '';
    }
}
