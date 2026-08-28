<?php

declare(strict_types=1);

namespace Besdk\Target\Php;

/**
 * Reading decoded JSON without lying about its type.
 *
 * The IR arrives from `json_decode`, so every value is `mixed` and every array is `array<mixed,mixed>` —
 * which is the truth, and which PHPStan at level 9 rightly refuses to let code pretend otherwise about.
 *
 * These are **normalisers, not casts.** The distinction matters: a cast silences the typechecker while
 * leaving the same wrong assumption in the code, where these return a well-formed value of the declared
 * type for any input. A malformed IR then produces a degraded SDK rather than a crash inside the emitter,
 * which is the right failure for a tool reading a file it did not write.
 */
final class Json
{
    /**
     * A string-keyed object, or an empty one.
     *
     * @return array<string,mixed>
     */
    public static function obj(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }
        $out = [];
        foreach ($value as $key => $item) {
            $out[(string) $key] = $item;
        }

        return $out;
    }

    /**
     * A list of objects, dropping anything that is not one.
     *
     * @return list<array<string,mixed>>
     */
    public static function objects(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }
        $out = [];
        foreach ($value as $item) {
            if (is_array($item)) {
                $out[] = self::obj($item);
            }
        }

        return $out;
    }

    /** A string, or the fallback. Never `(string) $mixed`, which stringifies an array to "Array". */
    public static function str(mixed $value, string $fallback = ''): string
    {
        return is_string($value) && $value !== '' ? $value : $fallback;
    }

    /**
     * @return list<string>
     */
    public static function strings(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }

        return array_values(array_filter($value, 'is_string'));
    }
}
