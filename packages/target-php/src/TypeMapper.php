<?php

declare(strict_types=1);

namespace Graft\Target\Php;

/**
 * IR type references to PHP types.
 *
 * Every method returns a pair: the **native** type PHP can enforce, and the **phpdoc** type PHPStan can
 * enforce. They differ exactly where PHP's type system stops short, which is the one real gap in PHP as a
 * target (SPEC.md §3.3.7):
 *
 * | IR                    | native      | phpdoc              |
 * |-----------------------|-------------|---------------------|
 * | `string`              | `string`    | `string`            |
 * | `array<string>`       | `array`     | `list<string>`      |
 * | `map<string,Widget>`  | `array`     | `array<string,Widget>` |
 * | `string \| int`       | `string\|int` | `string\|int`      |
 *
 * So a typed collection is `array` to the engine and `list<Widget>` to the typechecker. PHP has no
 * generics, so the phpdoc is not decoration — it is the only place the element type exists, and PHPStan at
 * level 9 is what makes it load-bearing rather than a comment.
 *
 * Unions, by contrast, PHP expresses *natively* and better than Go, which has to widen them to `any`.
 */
final class TypeMapper
{
    /** @var array<string,array<string,mixed>> named types by id */
    private array $byId = [];

    /** @var array<string,string> id to declared class or enum name */
    private array $names = [];

    /**
     * @param array<string,mixed> $ir
     */
    public function __construct(array $ir)
    {
        /** @var list<array<string,mixed>> $types */
        $types = is_array($ir['types'] ?? null) ? $ir['types'] : [];
        $taken = [];
        foreach ($types as $type) {
            $id = is_string($type['id'] ?? null) ? $type['id'] : null;
            if ($id === null) {
                continue;
            }
            $this->byId[$id] = $type;
            /** @var array{tokens: list<string>} $name */
            $name = is_array($type['name'] ?? null) ? $type['name'] : ['tokens' => ['value']];
            $tokens = is_array($name['tokens'] ?? null) ? array_values(array_filter($name['tokens'], 'is_string')) : ['value'];
            $candidate = Naming::pascal($tokens);
            // A collision would produce two classes with one name in one namespace, which does not
            // compile. Suffixed numerically rather than by role: the role is not always known here.
            $unique = $candidate;
            $suffix = 2;
            while (isset($taken[$unique])) {
                $unique = $candidate . $suffix++;
            }
            $taken[$unique] = true;
            $this->names[$id] = $unique;
        }
    }

    /** The declared class or enum name for a named type. */
    public function nameOf(string $id): string
    {
        return $this->names[$id] ?? 'mixed';
    }

    /**
     * @return array<string,array<string,mixed>>
     */
    public function types(): array
    {
        return $this->byId;
    }

    /**
     * The native PHP type for a reference, or null when PHP cannot express it.
     *
     * Null means "omit the type declaration and rely on phpdoc" — which happens for a union of a class and
     * a scalar in some positions, and for `mixed` inside a nullable. Returning null rather than falling
     * back to `mixed` matters: `mixed` in a signature tells PHPStan level 9 to give up on that value,
     * where an absent native type still lets the phpdoc carry it.
     *
     * @param array<string,mixed> $ref
     */
    public function native(array $ref, bool $nullable = false): string
    {
        $type = $this->nativeInner($ref);

        // Already-nullable types must not be wrapped again. `?string` does not contain the substring
        // `null`, so checking for that alone emitted `??string` — a syntax error, and one that only
        // appeared on a spec with an optional *and* nullable field. `?` cannot be combined with a union
        // either, which is why a type containing `null` is left alone.
        if (!$nullable || $type === 'mixed' || str_starts_with($type, '?') || str_contains($type, 'null')) {
            return $type;
        }

        return '?' . $type;
    }

    /**
     * @param array<string,mixed> $ref
     */
    private function nativeInner(array $ref): string
    {
        $kind = is_string($ref['kind'] ?? null) ? $ref['kind'] : 'unknown';

        return match ($kind) {
            'primitive' => match ($ref['type'] ?? '') {
                'string' => ($ref['format'] ?? null) === 'date-time' ? '\\DateTimeImmutable' : 'string',
                'integer' => 'int',
                'number' => 'float',
                'boolean' => 'bool',
                default => 'mixed',
            },
            // `array` for both, because PHP has one array type. The phpdoc distinguishes them.
            'array', 'map' => 'array',
            'named' => $this->nativeNamed($ref),
            'nullable' => '?' . ltrim($this->nativeInner(self::inner($ref, 'inner')), '?'),
            'binary' => 'string',
            'literal' => match (true) {
                is_string($ref['value'] ?? null) => 'string',
                is_int($ref['value'] ?? null) => 'int',
                is_bool($ref['value'] ?? null) => 'bool',
                default => 'mixed',
            },
            'union' => $this->nativeUnion($ref),
            'null' => 'null',
            default => 'mixed',
        };
    }

    /**
     * @param array<string,mixed> $ref
     */
    private function nativeNamed(array $ref): string
    {
        $id = is_string($ref['id'] ?? null) ? $ref['id'] : '';
        $type = $this->byId[$id] ?? null;
        if ($type === null) {
            return 'mixed';
        }
        if (($type['kind'] ?? null) === 'alias') {
            $target = is_array($type['target'] ?? null) ? $type['target'] : ['kind' => 'unknown'];

            return $this->nativeInner($target);
        }

        return $this->nameOf($id);
    }

    /**
     * A native union, which PHP has had since 8.0.
     *
     * Bailing to `mixed` when any branch is itself unrepresentable, because a partial union would claim
     * more than it can enforce. `array` cannot appear beside another array-ish branch either — PHP forbids
     * duplicate types in a union — so those collapse.
     *
     * @param array<string,mixed> $ref
     */
    private function nativeUnion(array $ref): string
    {
        /** @var list<array<string,mixed>> $variants */
        $variants = is_array($ref['variants'] ?? null) ? array_values($ref['variants']) : [];
        $parts = [];
        foreach ($variants as $variant) {
            $rendered = $this->nativeInner(is_array($variant) ? $variant : []);
            if ($rendered === 'mixed') {
                return 'mixed';
            }
            $parts[ltrim($rendered, '?')] = true;
        }
        $names = array_keys($parts);
        if ($names === []) {
            return 'mixed';
        }
        // A union of one is just that type — which happens once duplicates collapse.
        return implode('|', $names);
    }

    /**
     * The phpdoc type, which is where element types live.
     *
     * @param array<string,mixed> $ref
     */
    public function doc(array $ref): string
    {
        $kind = is_string($ref['kind'] ?? null) ? $ref['kind'] : 'unknown';

        return match ($kind) {
            'array' => 'list<' . $this->doc(self::inner($ref, 'items')) . '>',
            'map' => 'array<string,' . $this->doc(self::inner($ref, 'values')) . '>',
            'nullable' => 'null|' . $this->doc(self::inner($ref, 'inner')),
            'named' => $this->docNamed($ref),
            'union' => $this->docUnion($ref),
            // A literal is documented as its literal, which PHPStan understands and can narrow on.
            'literal' => match (true) {
                is_string($ref['value'] ?? null) => "'" . str_replace("'", "\\'", (string) $ref['value']) . "'",
                is_int($ref['value'] ?? null) => (string) $ref['value'],
                is_bool($ref['value'] ?? null) => $ref['value'] === true ? 'true' : 'false',
                default => 'mixed',
            },
            'unknown' => 'mixed',
            default => $this->nativeInner($ref),
        };
    }

    /**
     * @param array<string,mixed> $ref
     */
    private function docNamed(array $ref): string
    {
        $id = is_string($ref['id'] ?? null) ? $ref['id'] : '';
        $type = $this->byId[$id] ?? null;
        if ($type !== null && ($type['kind'] ?? null) === 'alias') {
            return $this->doc(is_array($type['target'] ?? null) ? $type['target'] : ['kind' => 'unknown']);
        }

        return $type === null ? 'mixed' : $this->nameOf($id);
    }

    /**
     * @param array<string,mixed> $ref
     */
    private function docUnion(array $ref): string
    {
        /** @var list<array<string,mixed>> $variants */
        $variants = is_array($ref['variants'] ?? null) ? array_values($ref['variants']) : [];
        $parts = [];
        foreach ($variants as $variant) {
            $parts[$this->doc(is_array($variant) ? $variant : [])] = true;
        }
        $names = array_keys($parts);

        return $names === [] ? 'mixed' : implode('|', $names);
    }

    /**
     * @param  array<string,mixed> $ref
     * @return array<string,mixed>
     */
    private static function inner(array $ref, string $key): array
    {
        $value = $ref[$key] ?? null;

        return is_array($value) ? $value : ['kind' => 'unknown'];
    }
}
