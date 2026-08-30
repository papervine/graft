<?php

declare(strict_types=1);

namespace Graft\Target\Php;

/**
 * Planning the runtime validation descriptor table (SPEC.md §3.4.1.1).
 *
 * The generated SDK ships descriptors as data and the hand-written runtime walks them. Two properties
 * matter and neither is obvious:
 *
 * **Only reachable types are emitted.** A descriptor is useful only for a type that appears in a
 * *response*, and a spec's type graph is much larger than its response graph. Stripe declares 1,440 types;
 * emitting all of them would put a large table in every consumer's package to validate shapes they can
 * never receive.
 *
 * **Cycles terminate through the table, not through recursion.** A named type becomes a `ref` into the
 * table rather than an inlined subtree, so a self-referential schema is finite by construction rather than
 * by a depth cap.
 */
final class Schemas
{
    /** @var array<string,array<string,mixed>> descriptor per emitted type name */
    private array $table = [];

    /** @var array<string,true> named types already emitted or in progress */
    private array $started = [];

    public function __construct(private readonly TypeMapper $types) {}

    /**
     * A descriptor for a type reference, adding anything it names to the table.
     *
     * @param  ?array<string,mixed> $ref
     * @return array<string,mixed>
     */
    public function describe(?array $ref): array
    {
        if ($ref === null) {
            return ['k' => 'any'];
        }
        $kind = is_string($ref['kind'] ?? null) ? $ref['kind'] : 'unknown';

        return match ($kind) {
            'primitive' => match ($ref['type'] ?? '') {
                // Only `date-time` is a date. A `date` stays a string, matching how the model decodes it.
                'string' => ($ref['format'] ?? null) === 'date-time' ? ['k' => 'date'] : ['k' => 'str'],
                'integer' => ['k' => 'int'],
                'number' => ['k' => 'num'],
                'boolean' => ['k' => 'bool'],
                default => ['k' => 'any'],
            },
            'array' => ['k' => 'arr', 'i' => $this->describe(self::sub($ref, 'items'))],
            'map' => ['k' => 'map', 'v' => $this->describe(self::sub($ref, 'values'))],
            'nullable' => ['k' => 'null', 'i' => $this->describe(self::sub($ref, 'inner'))],
            'named' => $this->describeNamedRef($ref),
            'union' => [
                'k' => 'or',
                'o' => array_map(
                    fn(array $variant): array => $this->describe($variant),
                    Json::objects($ref['variants'] ?? null),
                ),
            ],
            // Binary never reaches the JSON validator; a binary inside a JSON body is a base64 string.
            'binary' => ['k' => 'str'],
            // A literal is validated as its base type, for the same reason an enum is: a server widening it
            // must not become a decode failure.
            'literal' => match (true) {
                is_string($ref['value'] ?? null) => ['k' => 'str'],
                is_int($ref['value'] ?? null), is_float($ref['value'] ?? null) => ['k' => 'num'],
                default => ['k' => 'bool'],
            },
            default => ['k' => 'any'],
        };
    }

    /**
     * @param  array<string,mixed> $ref
     * @return array<string,mixed>
     */
    private function describeNamedRef(array $ref): array
    {
        $id = is_string($ref['id'] ?? null) ? $ref['id'] : '';
        $type = Json::obj($this->types->types()[$id] ?? null);
        if ($type === []) {
            return ['k' => 'any'];
        }
        // An alias is inlined: it has no class of its own, so a `ref` would point at nothing.
        if (($type['kind'] ?? null) === 'alias') {
            return $this->describe(Json::obj($type['target'] ?? null) ?: null);
        }
        $name = $this->types->nameOf($id);
        $this->ensure($id, $name, $type);

        return ['k' => 'ref', 'n' => $name];
    }

    /**
     * @param array<string,mixed> $type
     */
    private function ensure(string $id, string $name, array $type): void
    {
        if (isset($this->started[$id])) {
            return;
        }
        $this->started[$id] = true;
        // Reserved before recursing, so a self-reference finds the key present and emits a `ref`.
        $this->table[$name] = ['k' => 'any'];
        $this->table[$name] = $this->describeNamed($type);
    }

    /**
     * @param  array<string,mixed> $type
     * @return array<string,mixed>
     */
    private function describeNamed(array $type): array
    {
        return match ($type['kind'] ?? null) {
            // Base type only, never membership. Servers add enum values without warning, and the open-enum
            // rule (§3.3.1) exists precisely so that does not break a client.
            'enum' => $this->enumBase($type),
            'object' => $this->describeObject($type),
            default => ['k' => 'any'],
        };
    }

    /**
     * @param  array<string,mixed> $type
     * @return array<string,mixed>
     */
    private function enumBase(array $type): array
    {
        $members = Json::objects($type['members'] ?? null);
        foreach ($members as $member) {
            if (is_int($member['wireValue'] ?? null)) {
                return ['k' => 'num'];
            }
        }

        return ['k' => 'str'];
    }

    /**
     * @param  array<string,mixed> $type
     * @return array<string,mixed>
     */
    private function describeObject(array $type): array
    {
        $out = [];
        foreach (Json::objects($type['fields'] ?? null) as $field) {
            $wire = Json::str($field['wireName'] ?? null);
            $descriptor = $this->describe(Json::obj($field['type'] ?? null) ?: null);
            $out[] = ($field['required'] ?? false) === true
                ? [$wire, $descriptor, 1]
                : [$wire, $descriptor];
        }
        $result = ['k' => 'obj', 'f' => $out];
        $additional = Json::obj($type['additional'] ?? null) ?: null;
        if ($additional !== null) {
            $result['a'] = $this->describe($additional);
        }

        return $result;
    }

    /**
     * The table, sorted so output is byte-stable across runs.
     *
     * PHP preserves insertion order, which depends on traversal order — and an unstable generated file makes
     * every regeneration a spurious diff.
     *
     * @return array<string,array<string,mixed>>
     */
    public function table(): array
    {
        $sorted = $this->table;
        ksort($sorted);

        return $sorted;
    }

    /**
     * @param  array<string,mixed> $ref
     * @return ?array<string,mixed>
     */
    private static function sub(array $ref, string $key): ?array
    {
        return Json::obj($ref[$key] ?? null) ?: null;
    }
}
