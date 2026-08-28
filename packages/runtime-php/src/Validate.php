<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/**
 * Runtime response validation, walking a descriptor table (SPEC.md §3.4.1.1).
 *
 * The generated SDK ships a table of compact descriptors as data; this hand-written walker interprets it.
 * Data rather than generated code for the same reason the whole runtime is hand-written: one reviewed
 * interpreter beats N generated ones, and the table costs a fraction of the equivalent code.
 *
 * Two things this deliberately never checks:
 *
 * - **Unknown fields.** A server adding a field must not break a client. That is the whole point of an
 *   evolving API.
 * - **Enum membership.** Servers add enum values without warning, and the open-enum rule (§3.3.1) exists
 *   precisely so that does not break a client — checking membership here would reintroduce it.
 */
final class Validate
{
    /**
     * Collect the ways `$value` fails to match `$schema`.
     *
     * @param  array<string,mixed>       $schema  one descriptor
     * @param  array<string,mixed>       $table   named descriptors, for `ref`
     * @return list<string>
     */
    public static function check(mixed $value, array $schema, array $table, string $path = ''): array
    {
        $kind = $schema['k'] ?? 'any';
        $where = $path === '' ? 'the response' : $path;

        return match ($kind) {
            'any' => [],
            'str', 'date' => is_string($value) ? [] : [self::wrong($where, 'a string', $value)],
            'num' => is_int($value) || is_float($value) ? [] : [self::wrong($where, 'a number', $value)],
            // A JSON integer may arrive as a float that happens to be whole (1.0) once it has been through
            // a serializer that has no integer type. Rejecting that would fail on correct data.
            'int' => is_int($value) || (is_float($value) && $value === floor($value))
                ? []
                : [self::wrong($where, 'an integer', $value)],
            'bool' => is_bool($value) ? [] : [self::wrong($where, 'a boolean', $value)],
            'null' => $value === null
                ? []
                : self::check($value, self::sub($schema, 'i'), $table, $path),
            'arr' => self::array($value, $schema, $table, $where, $path),
            'map' => self::map($value, $schema, $table, $where, $path),
            'obj' => self::object($value, $schema, $table, $where, $path),
            'or' => self::union($value, $schema, $table, $where, $path),
            'ref' => self::ref($value, $schema, $table, $path),
            default => [],
        };
    }

    /**
     * Throw when validation fails, honouring the mode.
     *
     * @param array<string,mixed> $schema
     * @param array<string,mixed> $table
     */
    public static function enforce(
        mixed $value,
        array $schema,
        array $table,
        string $operation,
        ValidationMode $mode,
    ): void {
        if ($mode === ValidationMode::Off) {
            return;
        }
        $problems = self::check($value, $schema, $table);
        if ($problems === []) {
            return;
        }
        if ($mode === ValidationMode::Warn) {
            // `trigger_error` rather than `error_log`, so a caller's own error handler sees it.
            trigger_error(
                sprintf('%s: response did not match the declared shape — %s', $operation, $problems[0]),
                \E_USER_WARNING,
            );

            return;
        }

        throw new ResponseValidationError($operation, $problems);
    }

    /**
     * @param  array<string,mixed> $schema
     * @param  array<string,mixed> $table
     * @return list<string>
     */
    private static function array(mixed $value, array $schema, array $table, string $where, string $path): array
    {
        if (!is_array($value) || !array_is_list($value)) {
            return [self::wrong($where, 'an array', $value)];
        }
        $problems = [];
        foreach ($value as $index => $item) {
            foreach (self::check($item, self::sub($schema, 'i'), $table, $path . '[' . $index . ']') as $problem) {
                $problems[] = $problem;
            }
        }

        return $problems;
    }

    /**
     * @param  array<string,mixed> $schema
     * @param  array<string,mixed> $table
     * @return list<string>
     */
    private static function map(mixed $value, array $schema, array $table, string $where, string $path): array
    {
        // An empty map arrives as `[]` from a PHP backend, which is the artifact §3.1.2 names. It is a
        // valid empty map, not a wrong type.
        if (is_array($value) && $value === []) {
            return [];
        }
        if (!is_array($value) || array_is_list($value)) {
            return [self::wrong($where, 'an object', $value)];
        }
        $problems = [];
        foreach ($value as $key => $item) {
            foreach (self::check($item, self::sub($schema, 'v'), $table, self::join($path, (string) $key)) as $problem) {
                $problems[] = $problem;
            }
        }

        return $problems;
    }

    /**
     * @param  array<string,mixed> $schema
     * @param  array<string,mixed> $table
     * @return list<string>
     */
    private static function object(mixed $value, array $schema, array $table, string $where, string $path): array
    {
        if (!is_array($value) || (array_is_list($value) && $value !== [])) {
            return [self::wrong($where, 'an object', $value)];
        }
        $problems = [];
        /** @var list<array{0: string, 1: array<string, mixed>, 2?: int}> $fields */
        $fields = is_array($schema['f'] ?? null) ? $schema['f'] : [];
        foreach ($fields as $field) {
            $name = $field[0];
            $required = ($field[2] ?? 0) === 1;
            if (!array_key_exists($name, $value)) {
                if ($required) {
                    $problems[] = sprintf('%s is missing', self::join($path, $name));
                }
                continue;
            }
            foreach (self::check($value[$name], self::descriptor($field[1]), $table, self::join($path, $name)) as $problem) {
                $problems[] = $problem;
            }
        }
        // Unknown keys are never checked; see the class docblock.
        $additional = array_key_exists('a', $schema) ? self::descriptor($schema['a']) : null;
        if ($additional !== null) {
            $known = array_column($fields, 0);
            foreach ($value as $key => $item) {
                if (in_array((string) $key, $known, true)) {
                    continue;
                }
                foreach (self::check($item, $additional, $table, self::join($path, (string) $key)) as $problem) {
                    $problems[] = $problem;
                }
            }
        }

        return $problems;
    }

    /**
     * @param  array<string,mixed> $schema
     * @param  array<string,mixed> $table
     * @return list<string>
     */
    private static function union(mixed $value, array $schema, array $table, string $where, string $path): array
    {
        /** @var list<array<string,mixed>> $branches */
        $branches = array_map(
            static fn(mixed $branch): array => self::descriptor($branch),
            is_array($schema['o'] ?? null) ? array_values($schema['o']) : [],
        );
        foreach ($branches as $branch) {
            if (self::check($value, $branch, $table, $path) === []) {
                return [];
            }
        }

        // One message rather than every branch's failure: a union of five reporting five problems buries
        // the actual one. `anyOf` and `oneOf` are validated identically on purpose (§3.1.7).
        return [self::wrong($where, 'one of the declared shapes', $value)];
    }

    /**
     * @param  array<string,mixed> $schema
     * @param  array<string,mixed> $table
     * @return list<string>
     */
    private static function ref(mixed $value, array $schema, array $table, string $path): array
    {
        $name = $schema['n'] ?? null;
        if (!is_string($name)) {
            return [];
        }
        $target = $table[$name] ?? null;
        // A cycle terminates through the table rather than through recursion, so a self-referential schema
        // is finite by construction. A missing entry is treated as `any`: an incomplete table must not
        // reject correct data.
        return is_array($target) ? self::check($value, self::descriptor($target), $table, $path) : [];
    }

    /**
     * @param  array<string,mixed> $schema
     * @return array<string,mixed>
     */
    private static function sub(array $schema, string $key): array
    {
        return self::descriptor($schema[$key] ?? null);
    }

    /**
     * Coerce a decoded descriptor into the shape this walker expects.
     *
     * The table arrives from `json_decode`, so its key type is whatever the JSON had. Normalising here is
     * a real job rather than a cast: a malformed table must degrade to `any` — which accepts everything —
     * rather than reject data that is actually correct.
     *
     * @return array<string,mixed>
     */
    private static function descriptor(mixed $value): array
    {
        if (!is_array($value)) {
            return ['k' => 'any'];
        }
        $out = [];
        foreach ($value as $key => $item) {
            $out[(string) $key] = $item;
        }

        return $out;
    }

    private static function join(string $path, string $segment): string
    {
        return $path === '' ? $segment : $path . '.' . $segment;
    }

    private static function wrong(string $where, string $expected, mixed $actual): string
    {
        return sprintf('%s should be %s but was %s', $where, $expected, self::describe($actual));
    }

    /** What arrived, named the way JSON names it rather than the way PHP does. */
    private static function describe(mixed $value): string
    {
        return match (true) {
            $value === null => 'null',
            is_bool($value) => 'a boolean',
            is_int($value) => 'an integer',
            is_float($value) => 'a number',
            is_string($value) => 'a string',
            is_array($value) => array_is_list($value) ? 'an array' : 'an object',
            default => 'something else',
        };
    }
}
