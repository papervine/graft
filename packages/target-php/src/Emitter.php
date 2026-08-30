<?php

declare(strict_types=1);

namespace Graft\Target\Php;

/**
 * Turns an IR into PHP source files.
 *
 * Read models are `final readonly class`es with promoted constructor properties, so a response cannot be
 * mutated by the code that received it. Write bodies are **named arguments** rather than a builder object:
 * PHP has had named arguments since 8.0, so `$client->widgets->create(name: 'x')` needs no builder, and a
 * builder would be inventing a problem the language already solved (SPEC.md §3.3.7).
 */
final class Emitter
{
    private readonly TypeMapper $types;

    private readonly Schemas $schemas;

    /**
     * Enum wire value to PHP case name, per enum class, recorded by `enumSource`.
     *
     * @var array<string, array<string, string>>
     */
    private array $enumCases = [];

    /**
     * Classes referenced by the example currently being rendered, so it can import them.
     *
     * An example constructing `new MemberInvitedEvent(...)` without importing it is a fatal error at run
     * time — and PHP, unlike the other five languages, has no compiler to say so before it ships.
     *
     * @var array<string, true>
     */
    private array $exampleImports = [];

    /** @var list<array<string,mixed>> diagnostics travelling back in the manifest (SPEC.md §3.5) */
    private array $warnings = [];

    private readonly string $namespace;

    private readonly string $clientClass;

    /** @var array<string,mixed> */
    private readonly array $service;

    /**
     * @param array<string,mixed> $ir
     * @param array<string,mixed> $options
     * @param array<string,mixed> $brand
     */
    public function __construct(
        private readonly array $ir,
        private readonly array $options,
        private readonly array $brand,
    ) {
        $this->types = new TypeMapper($ir);
        $this->schemas = new Schemas($this->types);
        $this->service = is_array($ir['service'] ?? null) ? $ir['service'] : [];
        $package = is_string($options['packageName'] ?? null) && $options['packageName'] !== ''
            ? $options['packageName']
            : 'acme/sdk';
        $this->namespace = is_string($options['namespace'] ?? null) && $options['namespace'] !== ''
            ? trim($options['namespace'], '\\')
            : Naming::namespaceFor($package);
        $this->clientClass = $this->deriveClientClass();
    }

    /**
     * Every file the SDK consists of.
     *
     * @param  array<string,string> $runtime vendored runtime sources, keyed by filename
     * @return list<array{path: string, contents: string}>
     */
    public function emit(array $runtime): array
    {
        $files = [];

        foreach ($this->modelFiles() as $file) {
            $files[] = $file;
        }
        foreach ($this->resourceFiles() as $file) {
            $files[] = $file;
        }
        $files[] = $this->clientFile();
        $files[] = $this->errorAliasFile();

        // The runtime is vendored under `Core`, so the generated package has no dependency on the
        // generator and a consumer's `composer install` pulls nothing of ours.
        foreach ($runtime as $name => $contents) {
            $files[] = [
                'path' => 'src/Core/' . $name,
                'contents' => str_replace(
                    'namespace Graft\\Runtime;',
                    'namespace ' . $this->namespace . '\\Core;',
                    $contents,
                ),
            ];
        }

        // After the resources, so every response descriptor the methods asked for is in the table.
        $schemaFile = $this->schemaFile();
        if ($schemaFile !== null) {
            $files[] = $schemaFile;
        }

        $files[] = $this->composerFile();
        $files[] = $this->readmeFile();
        // The tool configs ship with the package, so a consumer runs the same gates graft does rather
        // than inventing their own and getting different answers.
        $files[] = $this->phpstanConfigFile();
        $files[] = $this->fixerConfigFile();
        $files[] = $this->phpunitConfigFile();
        $files[] = $this->testBootstrapFile();

        // Per-operation examples and tests (SPEC.md §3.11). Emitted after the resources, so a method the
        // target declined to generate is not referenced by an example.
        foreach ($this->exampleFiles() as $file) {
            $files[] = $file;
        }
        foreach ($this->testFiles() as $file) {
            $files[] = $file;
        }

        return $files;
    }

    // -- models ---------------------------------------------------------------

    /**
     * @return list<array{path: string, contents: string}>
     */
    private function modelFiles(): array
    {
        $files = [];
        foreach ($this->types->types() as $id => $type) {
            $kind = $type['kind'] ?? null;
            // An alias contributes no file: it resolves to its target everywhere it is referenced, and a
            // one-line class wrapping a string is noise a reader has to see through.
            if ($kind === 'alias') {
                continue;
            }
            $name = $this->types->nameOf($id);
            $files[] = [
                'path' => 'src/' . $name . '.php',
                'contents' => $kind === 'enum'
                    ? $this->enumSource($name, $type)
                    : $this->modelSource($name, $type),
            ];
        }

        return $files;
    }

    /**
     * A native PHP enum.
     *
     * Real since 8.1, and `tryFrom()` is exactly the open-enum behaviour §3.3.1 requires: it returns null
     * for a value the server added after this SDK was generated, where `from()` would throw and turn an
     * additive API change into a client crash.
     *
     * @param array<string,mixed> $type
     */
    private function enumSource(string $name, array $type): string
    {
        $members = Json::objects($type['members'] ?? null);
        $backing = 'string';
        foreach ($members as $member) {
            if (is_int($member['wireValue'] ?? null)) {
                $backing = 'int';
                break;
            }
        }

        $docs = is_array($type['docs'] ?? null) ? $type['docs'] : [];
        $builder = new Builder($this->namespace, [$this->brandNotice()]);
        $lines = Builder::prose(
            self::str($docs, 'summary') ?? $name . '.',
            self::str($docs, 'description'),
        );
        $lines[] = '';
        $lines[] = 'Use `tryFrom()` on a value from the API: it returns null for a member added after this';
        $lines[] = 'SDK was generated, where `from()` would throw and turn an additive change into a crash.';

        $body = Builder::docblock($lines);
        $body .= 'enum ' . $name . ': ' . $backing . "\n{\n";
        $seen = [];
        foreach ($members as $member) {
            $wire = $member['wireValue'] ?? null;
            $case = Naming::pascal($this->tokensOf($member['name'] ?? null));
            $unique = $case;
            $suffix = 2;
            while (isset($seen[$unique])) {
                $unique = $case . $suffix++;
            }
            $seen[$unique] = true;
            // Recorded, not recomputed downstream: uniquification depends on *order*, so an example
            // renderer deriving the case name independently would disagree the moment two members
            // sanitise to one identifier. The Python target had exactly this bug with attribute names.
            $this->enumCases[$name][Json::str($wire)] = $unique;
            $rendered = is_int($wire) ? (string) $wire : $this->quote(Json::str($wire));
            $body .= '    case ' . $unique . ' = ' . $rendered . ";\n";
        }
        $body .= '}';

        $builder->add($body);

        return $builder->render();
    }

    /**
     * @param array<string,mixed> $type
     */
    private function modelSource(string $name, array $type): string
    {
        $fields = Json::objects($type['fields'] ?? null);
        $role = Json::str($type['role'] ?? null, 'shared');
        $docs = Json::obj($type['docs'] ?? null);

        $builder = new Builder($this->namespace, [$this->brandNotice()]);
        // Imported unconditionally: a model with a required field narrows into it, and php-cs-fixer's
        // `no_unused_imports` removes it from the others. Deciding here would mean predicting what the
        // decoder emits, which is exactly the coupling that goes stale.
        $builder->import($this->namespace . '\\Core\\DecodeError');

        $lines = Builder::prose(self::str($docs, 'summary') ?? $name . '.', self::str($docs, 'description'));
        if ($role === 'read' || $role === 'shared') {
            $lines[] = '';
            $lines[] = 'Immutable: a response is not something the code that received it should change.';
        }

        $source = Builder::docblock($lines);
        $source .= 'final readonly class ' . $name . "\n{\n";

        // Required fields first, then optional. PHP requires parameters with defaults to come last, so
        // this is a language constraint rather than a style choice.
        usort($fields, static function (array $a, array $b): int {
            return (($b['required'] ?? false) === true ? 1 : 0) <=> (($a['required'] ?? false) === true ? 1 : 0);
        });

        $params = [];
        $docLines = [];
        foreach ($fields as $field) {
            $property = Naming::property($this->tokensOf($field['name'] ?? null));
            $ref = Json::obj($field['type'] ?? null) ?: ['kind' => 'unknown'];
            $required = ($field['required'] ?? false) === true;
            $native = $this->types->native($ref, !$required);
            $doc = $this->types->doc($ref);
            $needsDoc = $native === 'array' || $native === 'mixed' || str_contains($doc, '<');
            if ($needsDoc) {
                // The phpdoc is the only place an element type exists in PHP. PHPStan at level 9 is what
                // makes it enforceable rather than a comment.
                // `str_starts_with` because a nullable type's doc already carries `null|`; prefixing
                // again produced `null|null|list<Permission>`, which is legal and reads as a defect.
                $docLines[] = '@param '
                    . ($required || str_starts_with($doc, 'null|') ? $doc : 'null|' . $doc)
                    . ' $' . $property;
            }
            $fieldDocs = Json::obj($field['docs'] ?? null);
            $summary = self::str($fieldDocs, 'summary');
            $params[] = [
                'property' => $property,
                'native' => $native,
                'required' => $required,
                'summary' => $summary,
                'wire' => Json::str($field['wireName'] ?? null, $property),
                // The element class when the field is a list of models. Without it the field decoded to
                // raw arrays while the declared type said otherwise — the same behavioural bug the
                // paginator had, one level down.
                'itemClass' => $this->namedObjectClass($ref),
                // The *element* type of a list, so an optional list can be narrowed to the `list<T>` the
                // docblock declares. Without it the decoder returned the raw array, which PHPStan at
                // level 9 rejects — and which was also wrong at runtime, since the elements were never
                // converted.
                'element' => $this->elementRef($ref),
                'mapValue' => $this->mapValueRef($ref),
            ];
        }

        if ($docLines !== []) {
            $source .= Builder::docblock($docLines, 4);
        }
        $source .= "    public function __construct(\n";
        foreach ($params as $param) {
            if ($param['summary'] !== null && $param['summary'] !== '') {
                foreach (Builder::prose($param['summary'], null, 92) as $line) {
                    $source .= '        /** ' . $line . " */\n";
                    break;
                }
            }
            $source .= '        public ' . $param['native'] . ' $' . $param['property']
                . ($param['required'] ? '' : ' = null') . ",\n";
        }
        $source .= "    ) {}\n";

        $source .= "\n" . $this->fromArraySource($name, $params);
        $source .= '}';

        $builder->add($source);

        return $builder->render();
    }

    /**
     * A decoder from the wire shape.
     *
     * Generated per model rather than done reflectively, for two reasons. Reflection over promoted
     * constructor properties is slow enough to matter on a large response, and it cannot know that the wire
     * key is `_id` while the property is `$id` — that mapping only exists in the IR.
     *
     * **Each value is narrowed into a local before the constructor call.** The first version passed
     * `$data['name'] ?? null` straight in, and PHPStan level 9 rejected it: `mixed` given where `string` is
     * declared. That was not pedantry — the constructor would have raised a `TypeError` from inside the SDK
     * with no field name in it. Locals let the typechecker prove each argument, and let a required field of
     * the wrong type fail with a message saying which field and what was expected.
     *
     * @param list<array{property: string, native: string, required: bool, summary: ?string, wire: string, itemClass?: ?string, element?: ?array<string,mixed>, mapValue?: ?array<string,mixed>}> $params
     */
    private function fromArraySource(string $name, array $params): string
    {
        $source = Builder::docblock([
            'Build from a decoded JSON object.',
            '',
            // `array-key`, not `string`: this is `json_decode` output, so the key type is whatever the JSON
            // had. Declaring `string` made every nested call a PHPStan error at the caller, because a
            // decoded sub-object is `array<mixed,mixed>` until something narrows it — and narrowing it for
            // the sake of the signature would be a cast, not a check.
            '@param array<array-key,mixed> $' . $this->unshadowedArgName($params),
        ], 4);
        // A parameter name no property shadows. A model with a field called `data` produced
        // `$data = $data['data'] ?? null;` — which destroyed the parameter, so every later field read from
        // the decoded sub-value instead. Silent data corruption, not a type error: `has_more` was simply
        // always absent. PHPStan caught it; nothing else would have.
        $arg = $this->unshadowedArgName($params);
        $source .= '    public static function fromArray(array $' . $arg . '): self' . "\n    {\n";

        $throws = false;
        foreach ($params as $param) {
            $key = $this->quote($param['wire']);
            $local = '$' . $param['property'];
            $source .= '        ' . $local . ' = $' . $arg . '[' . $key . '] ?? null;' . "\n";
            [$narrowing, $needsThrow] = $this->narrow($param, $local, $key);
            $source .= $narrowing;
            $throws = $throws || $needsThrow;
        }

        $source .= "\n        return new self(\n";
        foreach ($params as $param) {
            $source .= '            ' . $param['property'] . ': $' . $param['property'] . ",\n";
        }
        $source .= "        );\n    }\n";

        if ($this->needsDateHelper($params)) {
            $source .= "\n" . $this->dateHelper();
        }
        if ($throws) {
            $source .= "\n" . $this->decodeErrorHelper($name);
        }

        return $source;
    }

    /**
     * Narrow one decoded value to its declared type.
     *
     * A **required** field of the wrong type throws, naming the field and what was expected — the backstop
     * for when validation is off, and a far better failure than a `TypeError` from inside a constructor.
     * An **optional** field of the wrong type becomes null: it was already allowed to be absent, and the
     * validator reports the mismatch with the field name in strict mode.
     *
     * @param  array{property: string, native: string, required: bool, summary: ?string, wire: string, itemClass?: ?string, element?: ?array<string,mixed>, mapValue?: ?array<string,mixed>} $param
     * @return array{0: string, 1: bool}
     */
    private function narrow(array $param, string $local, string $key): array
    {
        $native = $param['native'];
        $bare = ltrim($native, '?');
        $required = $param['required'];

        if ($bare === 'mixed') {
            return ['', false];
        }

        if ($bare === '\DateTimeImmutable') {
            // Assigned once, from the raw access, rather than read into a local and then overwritten.
            $line = '        ' . $local . ' = self::date(' . $local . ');' . "\n";
            if ($required) {
                $line .= '        if (' . $local . ' === null) {' . "\n"
                    . '            throw self::decodeError(' . $key . ", 'a timestamp');\n        }\n";

                return [$line, true];
            }

            return [$line, false];
        }

        if (preg_match('/^[A-Z][A-Za-z0-9]*$/', $bare) === 1) {
            return [$this->narrowNamed($bare, $local, $key, $required), $required];
        }

        $itemClass = is_string($param['itemClass'] ?? null) ? $param['itemClass'] : null;
        if ($bare === 'array' && $itemClass !== null) {
            $line = '        ' . $local . ' = array_map(' . "\n"
                . '            static fn (mixed $item): ' . $itemClass . ' => '
                . $itemClass . '::fromArray(is_array($item) ? $item : []),' . "\n"
                . '            is_array(' . $local . ') ? array_values(' . $local . ') : [],' . "\n"
                . "        );\n";

            return [$line, false];
        }

        // An optional array field, narrowed to the shape its docblock declares.
        //
        // `is_array($x) ? $x : null` leaves `array<mixed, mixed>`, which satisfies neither `list<T>` nor
        // `array<string, mixed>` — so PHPStan at level 9 rejects it, and the value is genuinely wrong at
        // run time too: the elements were never converted. Three shapes, each needing a different narrowing.
        $element = is_array($param['element'] ?? null) ? $param['element'] : null;
        $value = is_array($param['mapValue'] ?? null) ? $param['mapValue'] : null;
        if ($bare === 'array' && $itemClass === null && !$required) {
            // A map: filter to string keys, which is what `array<string, mixed>` claims. `array_filter`
            // with `ARRAY_FILTER_USE_KEY` keeps the keys, which is correct here and wrong for a list.
            if ($value !== null) {
                return [
                    '        ' . $local . ' = is_array(' . $local . ')' . "\n"
                        . '            ? array_filter(' . $local . ', '
                        . "static fn (mixed \$key): bool => is_string(\$key), \ARRAY_FILTER_USE_KEY)" . "\n"
                        . "            : null;\n",
                    false,
                ];
            }
            if ($element !== null) {
                $elementNative = $this->types->native($element, false);
                // A list of enums: each element converts through `tryFrom`, and an unknown member drops
                // rather than crashing the client — the same rule a scalar enum field follows.
                if ($this->isEnumClass($elementNative)) {
                    return [
                        '        ' . $local . ' = is_array(' . $local . ')' . "\n"
                            . '            ? array_values(array_filter(array_map(' . "\n"
                            . '                static fn (mixed $item): ?' . $elementNative . ' => '
                            . 'is_string($item) || is_int($item)' . "\n"
                            . '                    ? ' . $elementNative . '::tryFrom($item)' . "\n"
                            . '                    : null,' . "\n"
                            . '                ' . $local . ',' . "\n"
                            . '            ), static fn (?' . $elementNative . ' $item): bool => '
                            . '$item !== null))' . "\n"
                            . "            : null;\n",
                        false,
                    ];
                }
                // A list of scalars. `array_values(array_filter(...))` is what makes the result a `list<T>`:
                // filtering alone preserves the original keys, so the list-ness is lost.
                $guard = $this->guardFor($elementNative, '$item');
                if ($guard !== null) {
                    return [
                        '        ' . $local . ' = is_array(' . $local . ')' . "\n"
                            . '            ? array_values(array_filter(' . $local . ', '
                            . 'static fn (mixed $item): bool => ' . $guard . '))' . "\n"
                            . "            : null;\n",
                        false,
                    ];
                }
            }
        }

        $check = $this->guardFor($bare, $local);
        if ($check === null) {
            return ['', false];
        }

        if ($required) {
            $line = '        if (!' . $check . ') {' . "\n"
                . '            throw self::decodeError(' . $key . ', '
                . $this->quote($this->describeType($bare)) . ");\n        }\n";

            return [$line, true];
        }

        return ['        ' . $local . ' = ' . $check . ' ? ' . $local . ' : null;' . "\n", false];
    }

    private function narrowNamed(string $class, string $local, string $key, bool $required): string
    {
        if ($this->isEnumClass($class)) {
            // `tryFrom` rather than `from`: a member the server added after this SDK was generated must not
            // crash the client (SPEC.md §3.3.1).
            $line = '        ' . $local . ' = is_string(' . $local . ') || is_int(' . $local . ')' . "\n"
                . '            ? ' . $class . '::tryFrom(' . $local . ')' . "\n"
                . "            : null;\n";
            if ($required) {
                $line .= '        if (' . $local . ' === null) {' . "\n"
                    . '            throw self::decodeError(' . $key . ', '
                    . $this->quote('a known ' . $class . ' value') . ");\n        }\n";
            }

            return $line;
        }

        $line = '        ' . $local . ' = is_array(' . $local . ') ? ' . $class . '::fromArray(' . $local . ') : null;' . "\n";
        if ($required) {
            $line .= '        if (' . $local . ' === null) {' . "\n"
                . '            throw self::decodeError(' . $key . ', ' . $this->quote('an object') . ");\n        }\n";
        }

        return $line;
    }

    private function isEnumClass(string $class): bool
    {
        foreach ($this->types->types() as $id => $type) {
            if ($this->types->nameOf($id) === $class) {
                return ($type['kind'] ?? null) === 'enum';
            }
        }

        return false;
    }

    /** A type guard expression, or null when the type is one this cannot narrow precisely. */
    private function guardFor(string $bare, string $local): ?string
    {
        if (str_contains($bare, '|')) {
            $parts = [];
            foreach (explode('|', $bare) as $branch) {
                $guard = $this->guardFor($branch, $local);
                if ($guard === null) {
                    return null;
                }
                $parts[] = $guard;
            }

            return '(' . implode(' || ', $parts) . ')';
        }

        return match ($bare) {
            'string' => 'is_string(' . $local . ')',
            'int' => 'is_int(' . $local . ')',
            // A JSON number may arrive as an int where a float is declared; rejecting that would fail on
            // data that is correct.
            'float' => '(is_float(' . $local . ') || is_int(' . $local . '))',
            'bool' => 'is_bool(' . $local . ')',
            'array' => 'is_array(' . $local . ')',
            'null' => $local . ' === null',
            default => null,
        };
    }

    /**
     * The element type of a list, or null when the ref is not a list.
     *
     * Unwraps nullability first: a `?array` in the spec is a nullable wrapper around the array, and reading
     * the wrapper's own kind would find no element at all.
     *
     * @param  array<string,mixed> $ref
     * @return ?array<string,mixed>
     */
    private function elementRef(array $ref): ?array
    {
        $kind = Json::str($ref['kind'] ?? null, '');
        if ($kind === 'nullable') {
            $inner = Json::obj($ref['inner'] ?? null);

            return $inner === [] ? null : $this->elementRef($inner);
        }
        if ($kind !== 'array') {
            return null;
        }
        $items = Json::obj($ref['items'] ?? null);

        return $items === [] ? null : $items;
    }

    /**
     * Wire names on a body whose values are file contents.
     *
     * Read from the IR rather than guessed, and passed to the runtime because PHP alone cannot tell a file
     * from a text field by type — see `Multipart`.
     *
     * @param  mixed $ref
     * @return list<string>
     */
    private function binaryFieldNames(mixed $ref): array
    {
        if (!is_array($ref) || Json::str($ref['kind'] ?? null, '') !== 'named') {
            return [];
        }
        $id = Json::str($ref['id'] ?? null, '');
        $named = null;
        foreach ($this->types->types() as $candidateId => $candidate) {
            if ($candidateId === $id) {
                $named = $candidate;
                break;
            }
        }
        if (!is_array($named)) {
            return [];
        }
        $out = [];
        foreach (Json::objects($named['fields'] ?? null) as $field) {
            $type = Json::obj($field['type'] ?? null);
            // Unwrapped, because an optional binary field is a nullable wrapper around the binary.
            while (Json::str($type['kind'] ?? null, '') === 'nullable') {
                $type = Json::obj($type['inner'] ?? null);
            }
            if (Json::str($type['kind'] ?? null, '') === 'binary') {
                $out[] = Json::str($field['wireName'] ?? null, '');
            }
        }

        return $out;
    }

    /**
     * The value type of a map, or null when the ref is not one.
     *
     * Distinct from `elementRef` because a map and a list are both `array` in PHP and need opposite
     * narrowings: a map keeps its keys, a list must discard them to stay a list.
     *
     * @param  array<string,mixed> $ref
     * @return ?array<string,mixed>
     */
    private function mapValueRef(array $ref): ?array
    {
        $kind = Json::str($ref['kind'] ?? null, '');
        if ($kind === 'nullable') {
            $inner = Json::obj($ref['inner'] ?? null);

            return $inner === [] ? null : $this->mapValueRef($inner);
        }
        if ($kind !== 'map') {
            return null;
        }
        $values = Json::obj($ref['values'] ?? null);

        return $values === [] ? ['kind' => 'unknown'] : $values;
    }

    private function describeType(string $bare): string
    {
        return match ($bare) {
            'string' => 'a string',
            'int' => 'an integer',
            'float' => 'a number',
            'bool' => 'a boolean',
            'array' => 'an array',
            default => 'a ' . $bare,
        };
    }

    private function dateHelper(): string
    {
        return Builder::docblock([
            'Parse an RFC 3339 timestamp, tolerating a value that is already a date.',
            '',
            'Returns null on an unparseable value rather than throwing, so the caller above decides whether',
            'that is fatal — which depends on whether the field was required.',
        ], 4) . <<<'PHP'
    private static function date(mixed $value): ?\DateTimeImmutable
    {
        if ($value instanceof \DateTimeImmutable) {
            return $value;
        }
        if (!is_string($value) || $value === '') {
            return null;
        }

        try {
            return new \DateTimeImmutable($value);
        } catch (\Exception) {
            return null;
        }
    }

PHP;
    }

    private function decodeErrorHelper(string $name): string
    {
        return Builder::docblock([
            'A required field was absent or the wrong type.',
            '',
            'Names the class, the wire key, and what was expected. In strict validation mode the validator',
            'reports this first with more context; this is the backstop when validation is off.',
        ], 4)
            . '    private static function decodeError(string $key, string $expected): DecodeError' . "\n    {\n"
            . '        return new DecodeError(sprintf(' . "\n"
            . "            '%s: expected %s for `%s`',\n"
            . "            self::class,\n"
            . "            \$expected,\n"
            . "            \$key,\n"
            . "        ));\n    }\n";
    }

    /**
     * @param list<array{property: string, native: string, required: bool, summary: ?string, wire: string, itemClass?: ?string, element?: ?array<string,mixed>, mapValue?: ?array<string,mixed>}> $params
     */
    private function needsDateHelper(array $params): bool
    {
        foreach ($params as $param) {
            if (str_contains($param['native'], 'DateTimeImmutable')) {
                return true;
            }
        }

        return false;
    }

    private function brandNotice(): string
    {
        $notice = $this->brand['generatedNotice'] ?? null;

        return is_string($notice) ? $notice : 'Code generated. DO NOT EDIT.';
    }

    /**
     * @param array<string,mixed> $source
     */
    private static function str(array $source, string $key): ?string
    {
        $value = $source[$key] ?? null;

        return is_string($value) && $value !== '' ? $value : null;
    }

    private function deriveClientClass(): string
    {
        $configured = $this->options['clientName'] ?? null;
        if (is_string($configured) && $configured !== '') {
            return Naming::pascal([$configured]);
        }
        $display = $this->service['displayName'] ?? null;
        if (is_string($display) && $display !== '') {
            $cleaned = preg_replace('/[^A-Za-z0-9]/', '', $display) ?? '';
            if ($cleaned !== '') {
                return Naming::pascal([$cleaned]);
            }
        }
        /** @var array{tokens: list<string>} $name */
        $name = is_array($this->service['name'] ?? null) ? $this->service['name'] : ['tokens' => ['api']];
        $tokens = is_array($name['tokens'] ?? null)
            ? array_values(array_filter($name['tokens'], 'is_string'))
            : ['api'];

        return Naming::pascal($tokens);
    }

    /**
     * Diagnostics for the core to report.
     *
     * @return list<array<string,mixed>>
     */
    public function warnings(): array
    {
        return $this->warnings;
    }

    public function clientClass(): string
    {
        return $this->clientClass;
    }

    public function namespaceName(): string
    {
        return $this->namespace;
    }

    // -- resources ------------------------------------------------------------

    /**
     * @return list<array{path: string, contents: string}>
     */
    private function resourceFiles(): array
    {
        $files = [];
        foreach ($this->flatResources() as $resource) {
            $class = $this->resourceClass($resource);
            $files[] = ['path' => 'src/' . $class . '.php', 'contents' => $this->resourceSource($resource, $class)];
        }

        return $files;
    }

    /**
     * Every resource, parents before children.
     *
     * Flattened rather than nested, because PSR-4 puts one class per file regardless of nesting — the
     * subresource relationship survives as a property on the parent, not as a directory.
     *
     * @return list<array<string,mixed>>
     */
    private function flatResources(): array
    {
        $out = [];
        $walk = function (mixed $resources) use (&$walk, &$out): void {
            if (!is_array($resources)) {
                return;
            }
            foreach (Json::objects($resources) as $resource) {
                $out[] = $resource;
                $walk($resource['subresources'] ?? null);
            }
        };
        $walk($this->ir['resources'] ?? null);

        return $out;
    }

    /**
     * @param array<string,mixed> $resource
     */
    private function resourceClass(array $resource): string
    {
        return Naming::pascal($this->tokensOf($resource['name'] ?? null)) . 'Resource';
    }

    /**
     * @param array<string,mixed> $resource
     */
    private function resourceSource(array $resource, string $class): string
    {
        $builder = new Builder($this->namespace, [$this->brandNotice()]);
        $builder->import($this->namespace . '\\Core\\Client');
        $builder->import($this->namespace . '\\Core\\RequestOptions');

        $docs = is_array($resource['docs'] ?? null) ? $resource['docs'] : [];
        $label = implode(' ', $this->tokensOf($resource['name'] ?? null));
        $source = Builder::docblock(
            Builder::prose(self::str($docs, 'summary') ?? 'The ' . $label . ' resource.', self::str($docs, 'description')),
        );
        $source .= 'final class ' . $class . "\n{\n";

        // Bodies first, because whether any survived decides what the class declaration needs. A resource
        // whose only operation is skipped holds a `$client` nothing reads, which PHPStan at level 9 reports
        // as `property.onlyWritten` — so a conditional emission has to be resolved before anything derived
        // from it, not after.
        $bodies = [];
        foreach (Json::objects($resource['methods'] ?? null) as $method) {
            $body = $this->methodSource($resource, $method, $builder);
            if ($body !== '') {
                $bodies[] = $body;
            }
        }
        foreach ($this->subresourceAccessors($resource, $builder) as $accessor) {
            $bodies[] = $accessor;
        }

        // The client is held rather than extended: a resource *is not* a client, and inheriting would put
        // every transport method on the resource's public surface.
        $source .= $bodies === []
            ? "    /** @phpstan-ignore property.onlyWritten (every operation on this resource was skipped) */\n"
                . "    public function __construct(private readonly Client \$client) {}\n"
            : "    public function __construct(private readonly Client \$client) {}\n";

        foreach ($bodies as $body) {
            $source .= "\n" . $body;
        }

        $source .= '}';
        $builder->add($source);

        return $builder->render();
    }

    /**
     * @param  array<string,mixed> $resource
     * @return list<string>
     */
    private function subresourceAccessors(array $resource, Builder $builder): array
    {
        $out = [];
        foreach (Json::objects($resource['subresources'] ?? null) as $sub) {
            $class = $this->resourceClass($sub);
            $property = Naming::camel($this->tokensOf($sub['name'] ?? null));
            // A lazily-constructed accessor rather than an eager property: a spec with 200 resources would
            // otherwise build 200 objects to serve one call.
            $out[] = '    public function ' . $property . '(): ' . $class . "\n    {\n"
                . '        return new ' . $class . "(\$this->client);\n    }\n";
        }

        return $out;
    }

    /**
     * One method on a resource.
     *
     * @param array<string,mixed> $resource
     * @param array<string,mixed> $method
     */
    private function methodSource(array $resource, array $method, Builder $builder): string
    {
        $name = Naming::camel($this->tokensOf($method['name'] ?? null));
        $http = Json::obj($method['http'] ?? null);
        $verb = strtoupper(Json::str($http['verb'] ?? null, 'get'));
        $path = Json::str($http['path'] ?? null, '/');
        $docs = Json::obj($method['docs'] ?? null);

        // `http.params` is one list discriminated by `location`, not three lists. Read from the schema
        // rather than guessed at: reading `pathParams`/`queryParams` produced methods with no parameters
        // at all, silently — the third time this session that inventing an IR field name has cost a bug.
        $allParams = Json::objects($http['params'] ?? null);
        $pathParams = array_values(array_filter(
            $allParams,
            static fn(array $p): bool => ($p['location'] ?? null) === 'path',
        ));
        $queryParams = array_values(array_filter(
            $allParams,
            static fn(array $p): bool => ($p['location'] ?? null) === 'query',
        ));

        $signature = [];
        $pathArgs = [];
        foreach ($pathParams as $param) {
            $argName = Naming::camel($this->tokensOf($param['name'] ?? null));
            $ref = Json::obj($param['type'] ?? null) ?: ['kind' => 'primitive', 'type' => 'string'];
            $signature[] = ['name' => $argName, 'native' => $this->types->native($ref), 'default' => null];
            $wire = Json::str($param['wireName'] ?? null, $argName);
            $pathArgs[$wire] = $argName;
        }

        $body = Json::obj($method['body'] ?? null) ?: null;
        if ($body !== null) {
            // Named arguments carry the body: PHP has had them since 8.0, so a builder object would be
            // solving a problem the language does not have (SPEC.md §3.3.7).
            $signature[] = ['name' => 'body', 'native' => 'array', 'default' => null, 'doc' => 'array<string,mixed>'];
        }

        foreach ($queryParams as $param) {
            $argName = Naming::camel($this->tokensOf($param['name'] ?? null));
            $ref = Json::obj($param['type'] ?? null) ?: ['kind' => 'unknown'];
            $required = ($param['required'] ?? false) === true;
            $signature[] = [
                'name' => $argName,
                'native' => $this->types->native($ref, !$required),
                'default' => $required ? null : 'null',
                'wire' => Json::str($param['wireName'] ?? null, $argName),
                'query' => true,
            ];
        }
        $signature[] = ['name' => 'options', 'native' => '?RequestOptions', 'default' => 'null'];

        // Parameters with defaults must come last; PHP enforces it.
        usort($signature, static fn(array $a, array $b): int => ($a['default'] === null ? 0 : 1) <=> ($b['default'] === null ? 0 : 1));

        $response = Json::obj($method['response'] ?? null) ?: ['kind' => 'empty'];
        $pagination = Json::str($method['paginationId'] ?? null) ?: null;

        // Streaming is not implemented here, and the handshake does not claim it. Skipping the method is the
        // honest outcome: the first version emitted one that JSON-decoded an SSE stream, which cannot work
        // and looks like it should. A warning travels back so the omission is visible rather than silent.
        if (($response['kind'] ?? null) === 'stream') {
            $this->warnings[] = [
                'severity' => 'warn',
                'code' => 'X001',
                'message' => sprintf(
                    'The PHP target does not support streaming responses, so `%s` was not generated.',
                    $this->operationKey($resource, $method),
                ),
            ];

            return '';
        }

        [$returnNative, $returnDoc] = $this->returnTypes($response, $pagination, $builder);

        $docLines = Builder::prose(self::str($docs, 'summary'), self::str($docs, 'description'));
        foreach ($signature as $param) {
            if (isset($param['doc'])) {
                $docLines[] = '@param ' . $param['doc'] . ' $' . $param['name'];
            }
        }
        if ($returnDoc !== null) {
            $docLines[] = '@return ' . $returnDoc;
        }

        $source = Builder::docblock($docLines, 4);
        $params = [];
        foreach ($signature as $param) {
            $params[] = $param['native'] . ' $' . $param['name'] . ($param['default'] === null ? '' : ' = ' . $param['default']);
        }
        $source .= '    public function ' . $name . '(' . implode(', ', $params) . '): ' . $returnNative . "\n    {\n";
        $source .= $this->methodBody($resource, $method, $verb, $path, $pathArgs, $signature, $response, $pagination, $builder);
        $source .= "    }\n";

        return $source;
    }

    /**
     * The return type, native and phpdoc.
     *
     * @param  array<string,mixed> $response
     * @return array{0: string, 1: ?string}
     */
    private function returnTypes(array $response, ?string $pagination, Builder $builder): array
    {
        if ($pagination !== null) {
            $builder->import($this->namespace . '\\Core\\Paginator');
            $item = $this->paginatedItem($response, $pagination);
            // `Paginator` is the native type; the element type lives in the phpdoc, because PHP has no
            // generics. PHPStan reads the `@return` and narrows `foreach` over it correctly.
            return ['Paginator', 'Paginator<' . ($item ?? 'mixed') . '>'];
        }

        $kind = is_string($response['kind'] ?? null) ? $response['kind'] : 'empty';
        if ($kind === 'empty') {
            return ['void', null];
        }
        // `text/csv` and `text/plain` are strings, not JSON. The first version routed them through
        // `requestJson`, which decodes CSV to null or throws — a method that could never work.
        if ($kind === 'binary' || $kind === 'text') {
            return ['string', null];
        }
        $ref = Json::obj($response['type'] ?? null) ?: ['kind' => 'unknown'];
        $native = $this->types->native($ref);
        $doc = $this->decodedDoc($ref);

        return [$native, $native === 'array' || $native === 'mixed' || str_contains($doc, '<') ? $doc : null];
    }

    /**
     * The phpdoc element type for a paginated method.
     *
     * Derived from the method's *response* rather than from the pagination scheme, because the scheme
     * describes how to page — which parameter changes, where the cursor lives — and carries no item type.
     * A response of `list<Widget>` yields `Widget`; an envelope yields whatever sits at `itemsSource`.
     *
     * @param array<string,mixed> $response
     */
    private function paginatedItem(array $response, string $paginationId): ?string
    {
        if (($response['kind'] ?? null) !== 'json') {
            return null;
        }
        $ref = Json::obj($response['type'] ?? null) ?: null;
        if ($ref === null) {
            return null;
        }

        $items = $this->itemsSourceFor($paginationId);
        if ($items !== null && ($items['kind'] ?? null) === 'body') {
            // The items live inside an envelope, so walk to the field that holds them.
            $ref = Json::obj($this->walkToField($ref, Json::strings($items['path'] ?? null)) ?? $ref);
        }

        if (($ref['kind'] ?? null) === 'array') {
            $inner = Json::obj($ref['items'] ?? null) ?: null;

            return $inner === null ? null : $this->types->doc($inner);
        }

        return null;
    }

    /**
     * Follow a dotted path through named object types to the field it names.
     *
     * @param  array<string,mixed> $ref
     * @param  list<mixed>         $path
     * @return ?array<string,mixed>
     */
    private function walkToField(array $ref, array $path): ?array
    {
        $current = $ref;
        foreach ($path as $segment) {
            if (($current['kind'] ?? null) !== 'named') {
                return null;
            }
            $id = is_string($current['id'] ?? null) ? $current['id'] : '';
            $type = $this->types->types()[$id] ?? null;
            if (!is_array($type) || ($type['kind'] ?? null) !== 'object') {
                return null;
            }
            $found = null;
            foreach (Json::objects($type['fields'] ?? null) as $field) {
                if (($field['wireName'] ?? null) === $segment) {
                    $found = Json::obj($field['type'] ?? null) ?: null;
                    break;
                }
            }
            if ($found === null) {
                return null;
            }
            $current = $found;
        }

        return $current;
    }

    /**
     * @return ?array<string,mixed>
     */
    private function itemsSourceFor(string $paginationId): ?array
    {
        foreach (Json::objects($this->ir['pagination'] ?? null) as $scheme) {
            if (($scheme['id'] ?? null) === $paginationId) {
                return Json::obj($scheme['itemsSource'] ?? null) ?: null;
            }
        }

        return null;
    }

    /**
     * @param array<string,mixed>                                        $resource
     * @param array<string,mixed>                                        $method
     * @param array<string,string>                                       $pathArgs
     * @param list<array<string,mixed>>                                  $signature
     * @param array<string,mixed>                                        $response
     */
    private function methodBody(
        array $resource,
        array $method,
        string $verb,
        string $path,
        array $pathArgs,
        array $signature,
        array $response,
        ?string $pagination,
        Builder $builder,
    ): string {
        $out = '';

        $pathExpression = "'" . str_replace("'", "\\'", $path) . "'";
        if ($pathArgs !== []) {
            $builder->import($this->namespace . '\\Core\\Query');
            $pairs = [];
            foreach ($pathArgs as $wire => $arg) {
                $pairs[] = "'" . $wire . "' => \$" . $arg;
            }
            $pathExpression = 'Query::path(' . $pathExpression . ', [' . implode(', ', $pairs) . '])';
        }

        $queryPairs = [];
        foreach ($signature as $param) {
            if (($param['query'] ?? false) === true) {
                $wire = Json::str($param['wire'] ?? null, Json::str($param['name'] ?? null));
                $queryPairs[] = $this->quote($wire) . ' => $' . Json::str($param['name'] ?? null);
            }
        }
        $queryExpression = $queryPairs === [] ? '[]' : '[' . implode(', ', $queryPairs) . ']';

        $hasBody = is_array($method['body'] ?? null);
        // The encoding the spec declared, not a default. `application/x-www-form-urlencoded` sent as JSON
        // is a request the server rejects, and it was every write operation of every form-based API before
        // this branch existed.
        $bodyContentType = Json::str(Json::obj($method['body'] ?? null)['contentType'] ?? null, '');
        $isForm = str_contains(strtolower($bodyContentType), 'x-www-form-urlencoded');
        $isMultipart = str_starts_with(strtolower($bodyContentType), 'multipart/');
        $bodyExpression = $hasBody
            ? ($isForm ? 'Form::encode($body)' : 'json_encode($body, \\JSON_THROW_ON_ERROR)')
            : 'null';
        // The runtime takes the content type as a trailing argument, so only a non-default needs passing.
        $contentTypeArg = $hasBody && $isForm
            ? ", 'application/x-www-form-urlencoded'"
            : '';
        if ($isForm) {
            $builder->import($this->namespace . '\\Core\\Form');
        }
        // Multipart is encoded to a local first, because the *content type carries the boundary* the
        // encoder generated — inventing one separately from the body it delimits is the one mistake in
        // multipart framing that cannot be recovered from.
        $multipartPrelude = '';
        if ($hasBody && $isMultipart) {
            $builder->import($this->namespace . '\\Core\\Multipart');
            $fileFields = $this->binaryFieldNames(Json::obj($method['body'] ?? null)['type'] ?? null);
            $multipartPrelude = '        [$encoded, $contentType] = Multipart::encode($body, ['
                . implode(', ', array_map(fn(string $name): string => $this->quote($name), $fileFields))
                . "]);\n";
            $bodyExpression = '$encoded';
            $contentTypeArg = ', $contentType';
        }
        $out .= $multipartPrelude;

        if ($pagination !== null) {
            return $out . $this->paginatedBody(
                $pagination,
                $pathExpression,
                $queryExpression,
                $verb,
                $this->paginatedItemClass($response, $pagination),
                $this->paginatedItemDescriptor($response, $pagination),
                $this->operationKey($resource, $method),
                $this->closureCaptures($signature),
                $builder,
            );
        }

        $kind = is_string($response['kind'] ?? null) ? $response['kind'] : 'empty';

        if ($kind === 'empty') {
            $out .= '        $this->client->request(' . "'" . $verb . "', " . $pathExpression
                . ', ' . $queryExpression . ', ' . $bodyExpression . ", \$options" . $contentTypeArg . ");\n";

            return $out;
        }

        if ($kind === 'binary' || $kind === 'text') {
            $out .= '        return $this->client->request(' . "'" . $verb . "', " . $pathExpression
                . ', ' . $queryExpression . ', ' . $bodyExpression . ", \$options" . $contentTypeArg . ")->body;\n";

            return $out;
        }

        $out .= '        /** @var mixed $data */' . "\n";
        $out .= '        $data = $this->client->requestJson(' . "'" . $verb . "', " . $pathExpression
            . ', ' . $queryExpression . ', ' . $bodyExpression . ", \$options" . $contentTypeArg . ");\n";

        $ref = Json::obj($response['type'] ?? null) ?: ['kind' => 'unknown'];

        // Validated *before* decoding, so a mismatch is reported with the field path the spec declared
        // rather than as a TypeError from inside a constructor (SPEC.md §3.4.1.1).
        $descriptor = $this->schemas->describe($ref);
        if (($descriptor['k'] ?? 'any') !== 'any') {
            $builder->import($this->namespace . '\\Core\\Validate');
            $operation = $this->operationKey($resource, $method);
            $out .= '        Validate::enforce($data, ' . $this->renderDescriptor($descriptor)
                . ', Schemas::TABLE, ' . $this->quote($operation) . ", \$this->client->validationMode());\n";
        }

        $out .= $this->decodeExpression($ref, $builder);

        return $out;
    }

    /**
     * Turn decoded JSON into the declared type.
     *
     * @param array<string,mixed> $ref
     */
    private function decodeExpression(array $ref, Builder $builder): string
    {
        $kind = is_string($ref['kind'] ?? null) ? $ref['kind'] : 'unknown';

        if ($kind === 'named') {
            $id = is_string($ref['id'] ?? null) ? $ref['id'] : '';
            $type = $this->types->types()[$id] ?? null;
            if (is_array($type) && ($type['kind'] ?? null) === 'object') {
                return '        return ' . $this->types->nameOf($id) . "::fromArray(is_array(\$data) ? \$data : []);\n";
            }
            if (is_array($type) && ($type['kind'] ?? null) === 'enum') {
                // `tryFrom` rather than `from`: a member added after generation must not crash the client.
                return '        return ' . $this->types->nameOf($id)
                    . "::tryFrom(is_string(\$data) || is_int(\$data) ? \$data : '') ?? throw new \\UnexpectedValueException('unknown enum value');\n";
            }
        }

        if ($kind === 'array') {
            $items = is_array($ref['items'] ?? null) ? $ref['items'] : ['kind' => 'unknown'];
            if (($items['kind'] ?? null) === 'named') {
                $id = is_string($items['id'] ?? null) ? $items['id'] : '';
                $type = $this->types->types()[$id] ?? null;
                if (is_array($type) && ($type['kind'] ?? null) === 'object') {
                    $class = $this->types->nameOf($id);

                    return '        return array_map(' . "\n"
                        . '            static fn (mixed $item): ' . $class . ' => ' . $class . '::fromArray(is_array($item) ? $item : []),' . "\n"
                        . '            is_array($data) ? array_values($data) : [],' . "\n"
                        . "        );\n";
                }
            }

            return "        return is_array(\$data) ? array_values(\$data) : [];\n";
        }

        // A scalar, a map, or something structural: returned as decoded. The validator has already checked
        // the shape, so a cast here would only hide a mismatch it reported.
        return "        return \$data;\n";
    }

    /**
     * A paginated method returns a `Paginator` rather than one page.
     *
     * @param array<string,mixed> $itemDescriptor descriptor for one *item*, not the envelope
     * @param string              $captures       rendered `use (...)` list; see closureCaptures()
     */
    private function paginatedBody(
        string $paginationId,
        string $pathExpression,
        string $queryExpression,
        string $verb,
        ?string $itemClass,
        array $itemDescriptor,
        string $operation,
        string $captures,
        Builder $builder,
    ): string {
        $builder->import($this->namespace . '\\Core\\PaginationScheme');
        $scheme = $this->paginationScheme($paginationId);

        // Captured as a local because the decode closure is `static` — it needs no `$this`, and a static
        // closure cannot reach one.
        $out = '        $validationMode = $this->client->validationMode();' . "\n";
        $out .= '        $scheme = new PaginationScheme(' . "\n";
        $out .= "            style: '" . $scheme['style'] . "',\n";
        foreach (['itemsPath', 'cursorPath'] as $key) {
            if ($scheme[$key] !== null) {
                $out .= '            ' . $key . ': [' . $scheme[$key] . "],\n";
            }
        }
        foreach (['limitParam', 'offsetParam', 'pageParam', 'cursorParam', 'totalHeader'] as $key) {
            if ($scheme[$key] !== null) {
                $out .= '            ' . $key . ": '" . $scheme[$key] . "',\n";
            }
        }
        $out .= "        );\n\n";
        $out .= '        return new Paginator(' . "\n";
        $out .= "            \$scheme,\n";
        $out .= '            fn (array $params): array => $this->client->requestPage(' . "\n";
        $out .= "                '" . $verb . "',\n";
        $out .= '                ' . $pathExpression . ",\n";
        $out .= '                array_merge(' . $queryExpression . ', $params),' . "\n";
        $out .= "                \$options,\n";
        $out .= "            ),\n";
        $out .= '            ' . $queryExpression . ",\n";

        $validates = ($itemDescriptor['k'] ?? 'any') !== 'any';
        if ($itemClass !== null || $validates) {
            // One closure that validates each item and then decodes it.
            //
            // **Items, not the envelope.** A paginated method never touches `requestJson`, so validation
            // placed only there silently skips every list operation — the bug found in the TypeScript and
            // Go targets earlier, and reproduced here before the note was applied. But validating the
            // *envelope* is also wrong, and the cross-language suite caught that too: this spec declares
            // `has_more` required on the envelope while the mock omits it, so PHP rejected a page the other
            // three accepted. The caller receives items; the envelope is transport detail.
            //
            // Takes `mixed`, not `array`: the runtime declares `Closure(mixed): list<T>`, and a closure
            // narrower than the parameter it is assigned to is a contravariance error.
            $out .= '            static function (mixed $items) use ($validationMode): array {' . "\n";
            $out .= '                $list = is_array($items) ? array_values($items) : [];' . "\n";
            if ($validates) {
                $builder->import($this->namespace . '\\Core\\Validate');
                $out .= '                Validate::enforce($list, '
                    . $this->renderDescriptor(['k' => 'arr', 'i' => $itemDescriptor])
                    . ', Schemas::TABLE, ' . $this->quote($operation) . ", \$validationMode);\n";
            }
            if ($itemClass !== null) {
                $out .= "\n                return array_map(\n";
                $out .= '                    static fn (mixed $item): ' . $itemClass . ' => '
                    . $itemClass . '::fromArray(is_array($item) ? $item : []),' . "\n";
                $out .= "                    \$list,\n";
                $out .= "                );\n";
            } else {
                $out .= "\n                return \$list;\n";
            }
            $out .= "            },\n";
        }
        $out .= "        );\n";

        return $out;
    }

    /**
     * The model class each page item decodes to, or null when the items are not a named object type.
     *
     * Null is honest rather than a fallback: a page of strings has nothing to decode, and claiming a class
     * for it would be the bug this method exists to prevent.
     *
     * @param array<string,mixed> $response
     */
    private function paginatedItemClass(array $response, string $paginationId): ?string
    {
        if (($response['kind'] ?? null) !== 'json') {
            return null;
        }
        $ref = Json::obj($response['type'] ?? null) ?: null;
        if ($ref === null) {
            return null;
        }
        $items = $this->itemsSourceFor($paginationId);
        if ($items !== null && ($items['kind'] ?? null) === 'body') {
            $ref = Json::obj($this->walkToField($ref, Json::strings($items['path'] ?? null)) ?? $ref);
        }
        if (($ref['kind'] ?? null) !== 'array') {
            return null;
        }
        $inner = Json::obj($ref['items'] ?? null) ?: null;
        if ($inner === null || ($inner['kind'] ?? null) !== 'named') {
            return null;
        }
        $id = Json::str($inner['id'] ?? null);
        $type = $this->types->types()[$id] ?? null;

        return is_array($type) && ($type['kind'] ?? null) === 'object' ? $this->types->nameOf($id) : null;
    }

    /**
     * @return array{style: string, itemsPath: ?string, cursorPath: ?string, limitParam: ?string, offsetParam: ?string, pageParam: ?string, cursorParam: ?string, totalHeader: ?string}
     */
    private function paginationScheme(string $paginationId): array
    {
        $out = [
            'style' => 'offset',
            'itemsPath' => null,
            'cursorPath' => null,
            'limitParam' => null,
            'offsetParam' => null,
            'pageParam' => null,
            'cursorParam' => null,
            'totalHeader' => null,
        ];
        foreach (Json::objects($this->ir['pagination'] ?? null) as $scheme) {
            if (($scheme['id'] ?? null) !== $paginationId) {
                continue;
            }
            $out['style'] = Json::str($scheme['style'] ?? null, 'offset');
            foreach (['limitParam', 'offsetParam', 'pageParam', 'cursorParam'] as $key) {
                $value = $scheme[$key] ?? null;
                if (is_string($value) && $value !== '') {
                    $out[$key] = $value;
                }
            }
            $items = Json::obj($scheme['itemsSource'] ?? null);
            if (($items['kind'] ?? null) === 'body') {
                $out['itemsPath'] = $this->quotedPath(Json::strings($items['path'] ?? null));
            }
            $cursor = Json::obj($scheme['cursorSource'] ?? null);
            if (($cursor['kind'] ?? null) === 'body') {
                $out['cursorPath'] = $this->quotedPath(Json::strings($cursor['path'] ?? null));
            }
            $total = Json::obj($scheme['totalSource'] ?? null);
            if (($total['kind'] ?? null) === 'header') {
                $out['totalHeader'] = Json::str($total['name'] ?? null) ?: null;
            }
        }

        return $out;
    }

    /**
     * @param mixed $name
     * @return list<string>
     */

    // -- per-operation examples and tests (SPEC.md §3.11) ----------------------


    /**
     * One runnable example per operation.
     *
     * A script rather than a class, because that is what an example is — the shortest thing a reader can
     * copy. They sit outside `src/`, so PSR-4 does not apply and `phpstan` still checks them: an example
     * that stops typechecking fails generation rather than shipping a snippet that lies.
     *
     * @return list<array{path: string, contents: string}>
     */
    private function exampleFiles(): array
    {
        $files = [];
        foreach ($this->accessorPaths() as ['path' => $accessor, 'resource' => $resource]) {
            foreach (Json::objects($resource['methods'] ?? null) as $method) {
                if (Json::obj($method['example'] ?? null) === [] || $this->skips($resource, $method)) {
                    continue;
                }
                $call = Naming::camel($this->tokensOf($method['name'] ?? null));
                $http = Json::obj($method['http'] ?? null);
                $docs = Json::obj($method['docs'] ?? null);
                $summary = Json::str($docs['summary'] ?? null, $accessor . '->' . $call);
                $response = Json::obj($method['response'] ?? null);
                $kind = Json::str($response['kind'] ?? null, 'empty');
                $paginated = Json::str($method['paginationId'] ?? null) !== '';

                // Rendered first, because it is what populates `exampleImports`.
                $args = $this->exampleArgs($method, 'client');
                $invocation = '$client->' . $accessor . '->' . $call . '(' . $args . ')';

                $out = "<?php\n\ndeclare(strict_types=1);\n\n";
                $out .= "/**\n * " . str_replace('*/', '* /', $summary) . "\n *\n";
                $out .= ' * ' . strtoupper(Json::str($http['verb'] ?? null, 'get')) . ' '
                    . Json::str($http['path'] ?? null, '/') . "\n *\n";
                $out .= " * Values are synthesized from the spec, so ids and placeholders are not real.\n";
                $out .= " * Checked by PHPStan with this package, so it cannot drift out of date with the API.\n */\n\n";
                $out .= "require __DIR__ . '/../../vendor/autoload.php';\n\n";
                foreach ($this->sortedImports() as $import) {
                    $out .= 'use ' . $this->namespace . '\\' . $import . ";\n";
                }
                $out .= "\n\$client = new " . $this->clientClass . "();\n\n";
                if ($paginated || $kind === 'stream') {
                    $out .= 'foreach (' . $invocation . " as \$item) {\n    var_dump(\$item);\n}\n";
                } elseif ($kind === 'empty') {
                    $out .= $invocation . ";\n";
                } else {
                    $out .= '$result = ' . $invocation . ";\nvar_dump(\$result);\n";
                }

                $files[] = [
                    'path' => 'examples/operations/' . $this->operationSlug($accessor, $method) . '.php',
                    'contents' => $out,
                ];
            }
        }

        return $files;
    }

    /**
     * One test per operation, run against an injected transport.
     *
     * Asserts the four things generated code is responsible for — the interpolated path, the request body
     * and its content type, that an omitted optional parameter does not reach the wire, and that a declared
     * response decodes. Never a network call: a generated test hitting a real API would fail in CI for
     * reasons unrelated to the SDK, and the first thing anyone would do is delete it.
     *
     * @return list<array{path: string, contents: string}>
     */
    private function testFiles(): array
    {
        $files = [];
        foreach ($this->accessorPaths() as ['path' => $accessor, 'resource' => $resource]) {
            foreach (Json::objects($resource['methods'] ?? null) as $method) {
                $example = Json::obj($method['example'] ?? null);
                if ($example === [] || $this->skips($resource, $method)) {
                    continue;
                }
                $call = Naming::camel($this->tokensOf($method['name'] ?? null));
                $http = Json::obj($method['http'] ?? null);
                $verb = strtoupper(Json::str($http['verb'] ?? null, 'get'));
                $response = Json::obj($method['response'] ?? null);
                $kind = Json::str($response['kind'] ?? null, 'empty');
                $status = is_int($response['statusCode'] ?? null) ? $response['statusCode'] : 200;
                $paginated = Json::str($method['paginationId'] ?? null) !== '';
                $class = $this->operationSlug($accessor, $method) . 'Test';

                $payload = "''";
                $contentType = 'application/json';
                if (array_key_exists('response', $example)) {
                    if ($kind === 'text') {
                        $contentType = 'text/plain';
                        $payload = $this->quote(is_scalar($example['response']) ? (string) $example['response'] : '');
                    } else {
                        $payload = $this->quote(json_encode($example['response'], \JSON_THROW_ON_ERROR));
                    }
                }

                $args = $this->exampleArgs($method, 'client');
                $invocation = '$client->' . $accessor . '->' . $call . '(' . $args . ')';

                $out = "<?php\n\ndeclare(strict_types=1);\n\n";
                $out .= "/**\n * " . $accessor . '->' . $call . ' — ' . $verb . ' '
                    . Json::str($http['path'] ?? null, '/') . "\n *\n";
                $out .= " * Generated from the spec. Asserts the request this SDK builds and that the declared\n";
                $out .= " * response decodes; it asserts nothing about the API being up, because it never calls it.\n *\n";
                $out .= " * Regenerated on every run and not preserved — edit the spec, not this file.\n */\n\n";
                $out .= 'namespace ' . $this->namespace . "\\Tests\\Operations;\n\n";
                $out .= "use PHPUnit\\Framework\\TestCase;\n";
                foreach ($this->sortedImports() as $import) {
                    $out .= 'use ' . $this->namespace . '\\' . $import . ";\n";
                }
                $out .= 'use ' . $this->namespace . "\\Core\\HttpRequest;\n";
                $out .= 'use ' . $this->namespace . "\\Core\\HttpResponse;\n";
                $out .= 'use ' . $this->namespace . "\\Core\\Transport;\n\n";
                $out .= 'final class ' . $class . " extends TestCase\n{\n";
                $out .= "    public function testBuildsTheDocumentedRequest(): void\n    {\n";
                $out .= "        \$seen = null;\n";
                $out .= "        \$transport = new class(\$seen) implements Transport {\n";
                $out .= "            public function __construct(public ?HttpRequest &\$seen) {}\n\n";
                $out .= "            public function send(HttpRequest \$request, float \$timeout): HttpResponse\n            {\n";
                $out .= "                \$this->seen = \$request;\n\n";
                $out .= '                return new HttpResponse(' . $status . ', ' . $payload
                    . ", ['content-type' => " . $this->quote($contentType) . "]);\n";
                $out .= "            }\n        };\n\n";
                $out .= '        $client = new ' . $this->clientClass
                    . "(baseUrl: 'https://api.test', transport: \$transport);\n\n";
                if ($paginated || $kind === 'stream') {
                    $out .= "        foreach (" . $invocation . " as \$item) {\n            break;\n        }\n\n";
                } else {
                    $out .= '        ' . $invocation . ";\n\n";
                }
                $out .= "        self::assertNotNull(\$seen);\n";
                $out .= '        self::assertSame(' . $this->quote($verb) . ", \$seen->method);\n";
                $out .= '        self::assertSame(' . $this->quote($this->examplePath($method))
                    . ", parse_url(\$seen->url, \\PHP_URL_PATH));\n";

                $body = Json::obj($method['body'] ?? null);
                if ($body !== [] && array_key_exists('body', $example)) {
                    $declared = strtolower(Json::str($body['contentType'] ?? null, ''));
                    $out .= "\n        // Declared as `" . Json::str($body['contentType'] ?? null, '') . "` in the spec.\n";
                    $out .= "        \$sentType = \$seen->headers['Content-Type'] ?? '';\n";
                    if (str_contains($declared, 'x-www-form-urlencoded')) {
                        $out .= "        self::assertStringContainsString('x-www-form-urlencoded', \$sentType);\n";
                    } elseif (str_starts_with($declared, 'multipart/')) {
                        $out .= "        self::assertStringStartsWith('multipart/form-data', \$sentType);\n";
                        $out .= "        // A boundary is what makes a multipart body parseable at all.\n";
                        $out .= "        self::assertStringContainsString('boundary=', \$sentType);\n";
                    } else {
                        $out .= '        self::assertStringContainsString('
                            . $this->quote(Json::str($body['contentType'] ?? null, '')) . ", \$sentType);\n";
                        $out .= '        self::assertSame(' . $this->bareLiteral($example['body'])
                            . ", json_decode((string) \$seen->body, true));\n";
                    }
                }

                $hasOptionalQuery = false;
                foreach (Json::objects($http['params'] ?? null) as $param) {
                    if (Json::str($param['location'] ?? null) === 'query' && ($param['required'] ?? false) !== true) {
                        $hasOptionalQuery = true;
                    }
                }
                if ($hasOptionalQuery) {
                    $out .= "\n        // An omitted optional query parameter must not reach the wire at all. A\n";
                    $out .= "        // generator serializing null would send `?since=`, which a server reads as a value.\n";
                    $out .= "        parse_str((string) parse_url(\$seen->url, \\PHP_URL_QUERY), \$query);\n";
                    $out .= "        foreach (\$query as \$value) {\n";
                    $out .= "            self::assertNotSame('', \$value);\n        }\n";
                }
                $out .= "    }\n}\n";

                $files[] = ['path' => 'tests/operations/' . $class . '.php', 'contents' => $out];
            }
        }

        return $files;
    }

    /**
     * Whether this target declines to generate the operation, so no example or test is emitted for it.
     *
     * Reads the same condition `methodSource` uses. Duplicated narrowly rather than threaded through,
     * because the alternative is asking an emitter that has already written its output — but kept adjacent
     * in intent: a change there not made here produces examples calling methods that do not exist, which
     * the PHPStan gate reports rather than shipping.
     *
     * @param array<string,mixed> $resource
     * @param array<string,mixed> $method
     */
    private function skips(array $resource, array $method): bool
    {
        unset($resource);

        return Json::str(Json::obj($method['response'] ?? null)['kind'] ?? null) === 'stream';
    }

    /**
     * Render an example value from the IR as PHP source, guided by the type it must satisfy.
     *
     * The values come from `Method.example`, synthesized once in the core, so every language shows the
     * same data for the same operation. Only the rendering is here — which is the whole division that
     * section sets up, and the reason a target deciding *what* a plausible value is would be the sixth
     * copy of one judgment.
     *
     * Type-directed because PHP needs it: a model is a constructor call with named arguments, an enum is
     * a case reference, and neither can be produced from the JSON value alone.
     *
     * @param ?array<string,mixed> $ref
     */
    private function phpLiteral(?array $ref, mixed $value, int $indent = 0): string
    {
        $pad = str_repeat('    ', $indent + 1);
        $close = str_repeat('    ', $indent);

        if ($ref === null) {
            return $this->bareLiteral($value);
        }

        $kind = Json::str($ref['kind'] ?? null, '');
        if ($kind === 'nullable') {
            return $value === null ? 'null' : $this->phpLiteral(Json::obj($ref['inner'] ?? null) ?: null, $value, $indent);
        }
        if ($kind === 'array') {
            if (!is_array($value) || $value === []) {
                return '[]';
            }
            $items = Json::obj($ref['items'] ?? null) ?: null;
            $parts = [];
            foreach ($value as $item) {
                $parts[] = $pad . $this->phpLiteral($items, $item, $indent + 1);
            }

            return "[\n" . implode(",\n", $parts) . ",\n" . $close . ']';
        }
        if ($kind === 'union') {
            // The first variant, matching what the core synthesized from. Rendering against a different
            // variant than the value was built for produces something that does not typecheck.
            $variants = Json::objects($ref['variants'] ?? null);

            return $this->phpLiteral($variants[0] ?? null, $value, $indent);
        }
        if ($kind === 'named') {
            $id = Json::str($ref['id'] ?? null, '');
            $type = $this->types->types()[$id] ?? null;
            if (!is_array($type)) {
                return $this->bareLiteral($value);
            }
            $typeKind = Json::str($type['kind'] ?? null, '');
            if ($typeKind === 'alias') {
                return $this->phpLiteral(Json::obj($type['target'] ?? null) ?: null, $value, $indent);
            }
            $class = $this->types->nameOf($id);
            $this->exampleImports[$class] = true;
            if ($typeKind === 'enum') {
                // A case reference, not the wire string: a generated enum is a backed enum, and a string
                // does not satisfy a parameter typed as one. The case name is read from the map the enum
                // emitter recorded rather than recomputed.
                $case = $this->enumCases[$class][Json::str($value)] ?? null;

                return $case === null
                    ? $class . '::from(' . $this->bareLiteral($value) . ')'
                    : $class . '::' . $case;
            }
            if (!is_array($value)) {
                return $this->bareLiteral($value);
            }
            // Named arguments, which is what makes a generated example readable — and what the model's
            // own constructor declares.
            $args = [];
            foreach (Json::objects($type['fields'] ?? null) as $field) {
                $wire = Json::str($field['wireName'] ?? null, '');
                if (!array_key_exists($wire, $value)) {
                    continue;
                }
                $property = Naming::property($this->tokensOf($field['name'] ?? null));
                $args[] = $pad . $property . ': '
                    . $this->phpLiteral(Json::obj($field['type'] ?? null) ?: null, $value[$wire], $indent + 1);
            }

            return $args === []
                ? 'new ' . $class . '()'
                : 'new ' . $class . "(\n" . implode(",\n", $args) . ",\n" . $close . ')';
        }

        return $this->bareLiteral($value);
    }

    /**
     * Classes the rendered example references, the client first.
     *
     * Sorted, so regenerating produces identical bytes — and the client first because it is the one a
     * reader looks for.
     *
     * @return list<string>
     */
    private function sortedImports(): array
    {
        $classes = array_keys($this->exampleImports);
        sort($classes);
        $out = [$this->clientClass];
        foreach ($classes as $class) {
            if ($class !== $this->clientClass) {
                $out[] = $class;
            }
        }

        return $out;
    }

    /** A value with no type to guide it, which is correct for `mixed` and map values. */
    private function bareLiteral(mixed $value): string
    {
        if ($value === null) {
            return 'null';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_int($value)) {
            return (string) $value;
        }
        if (is_float($value)) {
            // An integral float is written as an integer: a JSON parser hands back `1.0` for an id, and
            // `1.0` where an `int` is declared does not typecheck.
            return $value === floor($value) && abs($value) < 1e15 ? (string) (int) $value : (string) $value;
        }
        if (is_string($value)) {
            return $this->quote($value);
        }
        if (is_array($value)) {
            $parts = [];
            $isList = array_is_list($value);
            foreach ($value as $key => $item) {
                $parts[] = $isList
                    ? $this->bareLiteral($item)
                    : $this->quote((string) $key) . ' => ' . $this->bareLiteral($item);
            }

            return '[' . implode(', ', $parts) . ']';
        }

        return 'null';
    }

    /**
     * Every resource paired with the accessor path that reaches it, e.g. `orgs->invoices`.
     *
     * The flat resource list has no paths, which is fine for emitting a class and useless for writing a
     * call: a nested resource reached as `$client->invoices` does not exist.
     *
     * @return list<array{path: string, resource: array<string,mixed>}>
     */
    private function accessorPaths(): array
    {
        $out = [];
        $walk = function (mixed $resources, string $prefix) use (&$walk, &$out): void {
            foreach (Json::objects($resources) as $resource) {
                $property = Naming::camel($this->tokensOf($resource['name'] ?? null));
                // A top-level resource is a readonly *property*; a nested one is a lazily-constructed
                // *method* (see `subresourceAccessors`). Treating both as properties produced examples
                // reaching `$client->orgs->invoices`, which does not exist — caught by PHPStan once the
                // examples were in scope.
                $path = $prefix === '' ? $property : $prefix . '->' . $property . '()';
                $out[] = ['path' => $path, 'resource' => $resource];
                $walk($resource['subresources'] ?? null, $path);
            }
        };
        $walk($this->ir['resources'] ?? null, '');

        return $out;
    }

    /**
     * The arguments for one call, from the IR's example.
     *
     * Path parameters positionally in declaration order, then the body, then required query parameters.
     * Getting that order wrong puts a `limit` where an `orgId` belongs.
     *
     * Rendered at indent zero, because a call in an example or a test starts at the left margin — passing
     * the enclosing depth produced a nested literal indented as though it were still inside one, which
     * php-cs-fixer does not reflow because it is inside an expression.
     *
     * @param array<string,mixed> $method
     */
    private function exampleArgs(array $method, string $variable): string
    {
        $this->exampleImports = [];
        $example = Json::obj($method['example'] ?? null);
        if ($example === []) {
            return '';
        }
        $params = Json::obj($example['params'] ?? null);
        $http = Json::obj($method['http'] ?? null);
        $args = [];

        foreach (Json::objects($http['params'] ?? null) as $param) {
            if (Json::str($param['location'] ?? null) !== 'path') {
                continue;
            }
            $wire = Json::str($param['wireName'] ?? null, '');
            $args[] = $this->phpLiteral(Json::obj($param['type'] ?? null) ?: null, $params[$wire] ?? null, 0);
        }
        $body = Json::obj($method['body'] ?? null);
        if ($body !== [] && array_key_exists('body', $example)) {
            // An array, always. *Every* PHP request body is typed `array<string,mixed>` in the signature —
            // named arguments carry it, so there is no model parameter to construct (see the body branch of
            // `methodSignature`). Rendering the model produced an argument the method does not accept, which
            // PHPStan caught the moment `examples` entered its scope.
            //
            // Read from the signature rule rather than from the IR type, because the two deliberately
            // disagree here and the signature is what a caller sees.
            $args[] = $this->bareLiteral($example['body']);
        }
        foreach (Json::objects($http['params'] ?? null) as $param) {
            $location = Json::str($param['location'] ?? null);
            if ($location === 'path' || $location === 'cookie') {
                continue;
            }
            $wire = Json::str($param['wireName'] ?? null, '');
            if (!array_key_exists($wire, $params)) {
                continue;
            }
            $name = Naming::camel($this->tokensOf($param['name'] ?? null));
            $args[] = $name . ': ' . $this->phpLiteral(Json::obj($param['type'] ?? null) ?: null, $params[$wire], 0);
        }
        unset($variable);

        return implode(', ', $args);
    }

    /**
     * The path the SDK should produce, with the example's values interpolated.
     *
     * Computed rather than asserted loosely, because path interpolation is one of the four things a
     * generated test exists to check — a test asserting only that the path *contains* a resource name
     * would pass while `/orgs/{orgId}/members` came out as `/orgs//members`.
     *
     * @param array<string,mixed> $method
     */
    private function examplePath(array $method): string
    {
        $http = Json::obj($method['http'] ?? null);
        $path = Json::str($http['path'] ?? null, '/');
        $params = Json::obj(Json::obj($method['example'] ?? null)['params'] ?? null);
        foreach (Json::objects($http['params'] ?? null) as $param) {
            if (Json::str($param['location'] ?? null) !== 'path') {
                continue;
            }
            $wire = Json::str($param['wireName'] ?? null, '');
            $value = $params[$wire] ?? '';
            $path = str_replace('{' . $wire . '}', rawurlencode(is_scalar($value) ? (string) $value : ''), $path);
        }

        return $path;
    }

    /**
     * A stable class-name stem for an operation, e.g. `OrgsInvoicesDownloadPdf`.
     *
     * PSR-4 requires the class name to match the filename, so this is both.
     *
     * @param array<string,mixed> $method
     */
    private function operationSlug(string $accessor, array $method): string
    {
        $tokens = array_merge(
            explode('_', str_replace('->', '_', $accessor)),
            $this->tokensOf($method['name'] ?? null),
        );

        return Naming::pascal(array_values(array_filter($tokens, static fn(string $t): bool => $t !== '')));
    }

    /**
     * A name's token sequence, or a placeholder when the IR gave none.
     *
     * @return list<string>
     */
    private function tokensOf(mixed $name): array
    {
        if (!is_array($name)) {
            return ['value'];
        }
        $out = Json::strings($name['tokens'] ?? null);

        return $out === [] ? ['value'] : $out;
    }

    // -- client and package ---------------------------------------------------

    /**
     * @return array{path: string, contents: string}
     */
    private function clientFile(): array
    {
        $builder = new Builder($this->namespace, [$this->brandNotice()]);
        $builder->import($this->namespace . '\\Core\\ApiKeyAuth');
        $builder->import($this->namespace . '\\Core\\Auth');
        $builder->import($this->namespace . '\\Core\\BasicAuth');
        $builder->import($this->namespace . '\\Core\\BearerAuth');
        $builder->import($this->namespace . '\\Core\\Client');
        $builder->import($this->namespace . '\\Core\\NoAuth');
        $builder->import($this->namespace . '\\Core\\Transport');
        $builder->import($this->namespace . '\\Core\\ValidationMode');

        /** @var list<array<string,mixed>> $auth */
        $auth = is_array($this->service['auth'] ?? null) ? array_values($this->service['auth']) : [];
        $hasBearer = $this->hasAuth($auth, 'bearer');
        $hasBasic = $this->hasAuth($auth, 'basic');
        $apiKey = $this->findAuth($auth, 'apiKey');

        $bearer = $this->findAuth($auth, 'bearer');
        $oauth2 = $this->findAuth($auth, 'oauth2');
        // Every credential the spec declares, paired with the environment variable it falls back to. The
        // names come from the IR rather than being recomputed here, so all six targets read the same
        // variable for the same credential.
        $envVars = [
            'token' => Json::str($bearer['envVar'] ?? null, ''),
            'username' => Json::str($this->findAuth($auth, 'basic')['usernameEnvVar'] ?? null, ''),
            'password' => Json::str($this->findAuth($auth, 'basic')['passwordEnvVar'] ?? null, ''),
            'apiKey' => Json::str($apiKey['envVar'] ?? null, ''),
            'clientId' => Json::str($oauth2['clientIdEnvVar'] ?? null, ''),
            'clientSecret' => Json::str($oauth2['clientSecretEnvVar'] ?? null, ''),
            'refreshToken' => Json::str($oauth2['refreshTokenEnvVar'] ?? null, ''),
        ];
        $baseUrl = $this->defaultBaseUrl();

        $lines = Builder::prose(
            'The ' . $this->clientClass . ' client.',
            'Construct one and reach every resource through it.',
        );
        $source = Builder::docblock($lines);
        $source .= 'final class ' . $this->clientClass . "\n{\n";
        $source .= "    private readonly Client \$client;\n";

        $resources = Json::objects($this->ir['resources'] ?? null);
        foreach ($resources as $resource) {
            $class = $this->resourceClass($resource);
            $property = Naming::camel($this->tokensOf($resource['name'] ?? null));
            $source .= '    public readonly ' . $class . ' $' . $property . ";\n";
        }

        $params = [];
        if ($hasBearer) {
            $params[] = ['?string $token = null', 'Bearer token. Read from ' . $envVars['token'] . ' when omitted.'];
        }
        if ($hasBasic) {
            $params[] = ['?string $username = null', 'Used with $password for HTTP Basic auth.'];
            $params[] = ['?string $password = null', 'Used with $username for HTTP Basic auth.'];
        }
        if ($apiKey !== null) {
            $params[] = [
                '?string $apiKey = null',
                'Sent as the ' . Json::str($apiKey['wireName'] ?? null, 'X-Api-Key')
                    . ' ' . Json::str($apiKey['location'] ?? null, 'header') . '.',
            ];
        }
        if ($oauth2 !== null) {
            if (Json::str($oauth2['flow'] ?? null) === 'clientCredentials') {
                $params[] = [
                    '?string $clientId = null',
                    'OAuth2 client id. With $clientSecret, this SDK obtains and refreshes tokens for you.',
                ];
                $params[] = ['?string $clientSecret = null', 'OAuth2 client secret. Used with $clientId.'];
            } else {
                $params[] = [
                    '?string $refreshToken = null',
                    'A refresh token from your own authorization-code flow; the SDK keeps the access '
                        . 'token current.',
                ];
                $params[] = ['?string $clientId = null', 'OAuth2 client id, when the token endpoint needs one.'];
                $params[] = ['?string $clientSecret = null', 'OAuth2 client secret, when the token endpoint needs one.'];
            }
            /** @var list<string> $scopeNames */
            $scopeNames = [];
            foreach (Json::objects($oauth2['scopes'] ?? null) as $scope) {
                $scopeNames[] = Json::str($scope['name'] ?? null, '');
            }
            $params[] = [
                'array $scopes = []',
                $scopeNames === []
                    ? 'Scopes to request.'
                    : 'Scopes to request. Declared by this API: ' . implode(', ', $scopeNames) . '.',
            ];
        }
        $params[] = ['?string $baseUrl = null', 'Overrides the URL from the spec.'];
        $params[] = ['float $timeout = 60.0', 'Per-attempt timeout in seconds.'];
        $params[] = ['int $maxRetries = 2', 'Additional attempts for retryable failures.'];
        $params[] = ['array $defaultHeaders = []', null];
        $params[] = ['?Transport $transport = null', 'Inject one to test without real network calls.'];
        $params[] = ['?ValidationMode $validation = null', 'How strictly responses are checked.'];

        $docLines = ['@param array<string,string> $defaultHeaders'];
        if ($oauth2 !== null) {
            $docLines[] = '@param list<string> $scopes';
        }
        $source .= "\n" . Builder::docblock($docLines, 4);
        $source .= "    public function __construct(\n";
        foreach ($params as [$declaration, $comment]) {
            if ($comment !== null) {
                $source .= '        /** ' . $comment . " */\n";
            }
            $source .= '        ' . $declaration . ",\n";
        }
        $source .= "    ) {\n";

        // Credentials resolved into locals first, so the `match` below reads each one by a single name.
        // Reading `getenv()` inside a `match` arm meant the condition and the value each called it —
        // two expressions for one credential, and only the condition was ever kept in step.
        foreach (['token', 'username', 'password', 'apiKey', 'clientId', 'clientSecret', 'refreshToken'] as $credential) {
            if ($envVars[$credential] === '') {
                continue;
            }
            $source .= '        $' . $credential . ' ??= getenv(' . $this->quote($envVars[$credential])
                . ") ?: null;\n";
        }
        $source .= $this->oauth2Prelude($oauth2, $builder);
        $source .= '        $auth = ' . $this->authExpression($hasBearer, $hasBasic, $apiKey, $oauth2) . ";\n";
        $source .= "\n        \$this->client = new Client(\n";
        $source .= '            baseUrl: $baseUrl ?? ' . $baseUrl . ",\n";
        $source .= "            auth: \$auth,\n";
        $source .= "            timeout: \$timeout,\n";
        $source .= "            maxRetries: \$maxRetries,\n";
        $source .= "            defaultHeaders: \$defaultHeaders,\n";
        $source .= "            transport: \$transport,\n";
        $source .= '            userAgent: ' . $this->quote($this->userAgent()) . ",\n";
        $source .= "            validation: \$validation ?? ValidationMode::" . $this->validationCase() . ",\n";
        $idempotency = $this->options['idempotencyHeader'] ?? null;
        if (is_string($idempotency) && $idempotency !== '') {
            $source .= '            idempotencyHeader: ' . $this->quote($idempotency) . ",\n";
        }
        $source .= "        );\n";

        foreach ($resources as $resource) {
            if (!is_array($resource)) {
                continue;
            }
            $class = $this->resourceClass($resource);
            $property = Naming::camel($this->tokensOf($resource['name'] ?? null));
            $source .= '        $this->' . $property . ' = new ' . $class . "(\$this->client);\n";
        }
        $source .= "    }\n";

        $source .= "\n" . Builder::docblock(['The underlying transport, for a call this SDK does not cover yet.'], 4);
        $source .= "    public function core(): Client\n    {\n        return \$this->client;\n    }\n";
        $source .= '}';

        $builder->add($source);

        return ['path' => 'src/' . $this->clientClass . '.php', 'contents' => $builder->render()];
    }

    /**
     * The auth expression, giving every declared scheme a branch.
     *
     * Every scheme the spec declares gets one. An earlier version of the TypeScript target checked only for
     * a bearer token, so a spec declaring both OAuth2 and an API key generated a client that silently
     * ignored the key — it compiled, it looked right, and it could not authenticate (SPEC.md §3.1.6).
     *
     * @param ?array<string,mixed> $apiKey
     */
    /**
     * The token source, built before the auth expression so the expression stays one `match`.
     *
     * A local rather than an inline construction, because the source needs the caller's transport — a token
     * fetched over a different one would bypass a test's injected transport and make a real network call
     * for authentication, which is the whole point of being able to inject it.
     *
     * @param ?array<string,mixed> $oauth2
     */
    private function oauth2Prelude(?array $oauth2, Builder $builder): string
    {
        if ($oauth2 === null) {
            return '';
        }
        $builder->import($this->namespace . '\\Core\\OAuth2Auth');
        $builder->import($this->namespace . '\\Core\\OAuth2Config');
        $builder->import($this->namespace . '\\Core\\TokenSource');

        $scopeNames = [];
        foreach (Json::objects($oauth2['scopes'] ?? null) as $scope) {
            $scopeNames[] = $this->quote(Json::str($scope['name'] ?? null, ''));
        }
        $defaultScopes = $scopeNames === [] ? '$scopes' : '$scopes ?: [' . implode(', ', $scopeNames) . ']';
        $isClientCredentials = Json::str($oauth2['flow'] ?? null) === 'clientCredentials';
        $ready = $isClientCredentials
            ? '$clientId !== null && $clientSecret !== null'
            : '$refreshToken !== null';

        $out = '        $tokenSource = ' . $ready . " ? new TokenSource(\n";
        $out .= "            new OAuth2Config(\n";
        $out .= '                tokenUrl: ' . $this->quote(Json::str($oauth2['tokenUrl'] ?? null, '')) . ",\n";
        $out .= "                clientId: \$clientId,\n";
        $out .= "                clientSecret: \$clientSecret,\n";
        if (!$isClientCredentials) {
            $out .= "                refreshToken: \$refreshToken,\n";
        }
        $out .= '                scopes: ' . $defaultScopes . ",\n";
        $out .= "            ),\n";
        // The caller's transport, or the default the Client would build. `?? new CurlTransport()` rather
        // than null, because TokenSource requires one and the Client's own default is not reachable here.
        $out .= "            \$transport ?? new CurlTransport(),\n";
        $out .= "        ) : null;\n";
        $builder->import($this->namespace . '\\Core\\CurlTransport');

        return $out;
    }

    /**
     * @param ?array<string,mixed> $apiKey
     * @param ?array<string,mixed> $oauth2
     */
    private function authExpression(bool $hasBearer, bool $hasBasic, ?array $apiKey, ?array $oauth2 = null): string
    {
        $rungs = [];
        if ($oauth2 !== null) {
            // OAuth2 first: a spec declaring it alongside a static credential means "fetch a token, or
            // accept one I already have", and the fetched one is the fresher of the two.
            $rungs[] = ['$tokenSource !== null', 'new OAuth2Auth($tokenSource)'];
        }
        if ($hasBearer) {
            $rungs[] = ['$token !== null', 'new BearerAuth($token)'];
        }
        if ($hasBasic) {
            $rungs[] = ['$username !== null && $password !== null', 'new BasicAuth($username, $password)'];
        }
        if ($apiKey !== null) {
            $name = $this->quote(is_string($apiKey['wireName'] ?? null) ? $apiKey['wireName'] : 'X-Api-Key');
            $inQuery = ($apiKey['location'] ?? 'header') === 'query' ? 'true' : 'false';
            $rungs[] = ['$apiKey !== null', 'new ApiKeyAuth($apiKey, ' . $name . ', ' . $inQuery . ')'];
        }
        if ($rungs === []) {
            return 'new NoAuth()';
        }

        // One `match` with a branch per scheme, laid out over several lines. A nested single-line `match`
        // is legal PHP and unreadable, and php-cs-fixer will not break up an expression — so layout of a
        // generated expression is the emitter's job, not the formatter's.
        $lines = ['match (true) {'];
        foreach ($rungs as [$condition, $value]) {
            $lines[] = '            ' . $condition . ' => ' . $value . ',';
        }
        $lines[] = '            default => new NoAuth(),';
        $lines[] = '        }';

        return implode("\n", $lines);
    }

    /**
     * @param list<array<string,mixed>> $auth
     */
    private function hasAuth(array $auth, string $kind): bool
    {
        return $this->findAuth($auth, $kind) !== null;
    }

    /**
     * @param  list<array<string,mixed>> $auth
     * @return ?array<string,mixed>
     */
    private function findAuth(array $auth, string $kind): ?array
    {
        foreach ($auth as $scheme) {
            if (is_array($scheme) && ($scheme['kind'] ?? null) === $kind) {
                return $scheme;
            }
        }

        return null;
    }

    private function validationCase(): string
    {
        return match ($this->options['validation'] ?? 'strict') {
            'warn' => 'Warn',
            'off' => 'Off',
            default => 'Strict',
        };
    }

    private function defaultBaseUrl(): string
    {
        /** @var list<array<string,mixed>> $servers */
        $servers = is_array($this->service['servers'] ?? null) ? array_values($this->service['servers']) : [];
        $chosen = null;
        foreach ($servers as $server) {
            if (!is_array($server)) {
                continue;
            }
            if ($chosen === null || ($server['default'] ?? false) === true) {
                $chosen = $server;
            }
        }

        return $this->quote(is_string($chosen['url'] ?? null) ? $chosen['url'] : '');
    }

    private function userAgent(): string
    {
        $version = is_string($this->service['version'] ?? null) ? $this->service['version'] : '0.0.0';

        return strtolower($this->clientClass) . '/' . $version . ' php';
    }

    private function quote(string $value): string
    {
        return "'" . str_replace(['\\', "'"], ['\\\\', "\\'"], $value) . "'";
    }

    /**
     * Aliases every error class under the consumer's own brand.
     *
     * The runtime's base is `SdkError`, named for its role. Generated code aliases it to
     * `<ClientName>Error` so a catch block reads in the user's terms rather than ours — and so a rename of
     * this project is not a breaking change for every SDK it ever produced (SPEC.md §1.2).
     *
     * @return array{path: string, contents: string}
     */
    private function errorAliasFile(): array
    {
        $builder = new Builder($this->namespace, [
            $this->brandNotice(),
            '',
            'Error classes, under this SDK\'s own name.',
        ]);
        $alias = $this->clientClass . 'Error';
        $builder->import($this->namespace . '\\Core\\SdkError');

        $source = Builder::docblock([
            'Every error this SDK raises satisfies this type.',
            '',
            'An empty subclass rather than a `class_alias`, so `catch (' . $alias . ' $e)` works in a',
            'static analyser as well as at runtime.',
        ]);
        $source .= 'abstract class ' . $alias . " extends SdkError\n{\n}";
        $builder->add($source);

        return ['path' => 'src/' . $alias . '.php', 'contents' => $builder->render()];
    }

    /**
     * @return array{path: string, contents: string}
     */
    private function composerFile(): array
    {
        $package = is_string($this->options['packageName'] ?? null) && $this->options['packageName'] !== ''
            ? $this->options['packageName']
            : 'acme/sdk';
        $manifest = [
            'name' => $package,
            'description' => 'PHP SDK for ' . $this->serviceLabel() . '.',
            'type' => 'library',
            'require' => ['php' => '>=8.4', 'ext-curl' => '*', 'ext-json' => '*'],
            'require-dev' => [
                'phpstan/phpstan' => '^2.0',
                'friendsofphp/php-cs-fixer' => '^3.64',
                // The generated per-operation tests need a runner. A dev dependency, so nobody who
                // installs this package receives it.
                'phpunit/phpunit' => '^11.0',
            ],
            'autoload' => ['psr-4' => [$this->namespace . '\\' => 'src/']],
            // The tests are PSR-4 too, under a `Tests` sub-namespace — a class in `tests/` is not
            // autoloadable otherwise, and PHPUnit finds test cases by autoloading them.
            'autoload-dev' => ['psr-4' => [$this->namespace . '\\Tests\\' => 'tests/']],
            'config' => ['sort-packages' => true],
        ];
        $version = $this->options['sdkVersion'] ?? null;
        if (is_string($version) && $version !== '') {
            // Composer resolves a package version from its git tag, so this is written only when
            // `graft release` has recorded one — an invented version would conflict with the tag.
            $manifest['version'] = $version;
        }

        return [
            'path' => 'composer.json',
            'contents' => json_encode(
                $manifest,
                \JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES | \JSON_THROW_ON_ERROR,
            ) . "\n",
        ];
    }

    private function serviceLabel(): string
    {
        $display = $this->service['displayName'] ?? null;
        if (is_string($display) && $display !== '') {
            return $display;
        }

        return implode(' ', $this->tokensOf($this->service['name'] ?? null));
    }

    /**
     * @return array{path: string, contents: string}
     */
    private function readmeFile(): array
    {
        $package = is_string($this->options['packageName'] ?? null) ? $this->options['packageName'] : 'acme/sdk';
        $label = $this->serviceLabel();
        $version = is_string($this->service['version'] ?? null) ? $this->service['version'] : '';
        $attribution = is_string($this->brand['attribution'] ?? null) ? $this->brand['attribution'] : '';

        $lines = [
            '# ' . $package,
            '',
            'PHP SDK for ' . $label . ($version === '' ? '' : ' v' . $version) . '.',
            '',
            '## Install',
            '',
            '```sh',
            'composer require ' . $package,
            '```',
            '',
            'Requires PHP 8.4 or later.',
            '',
            '## Quick start',
            '',
            '```php',
            '<?php',
            '',
            "require 'vendor/autoload.php';",
            '',
            'use ' . $this->namespace . '\\' . $this->clientClass . ';',
            '',
            '$client = new ' . $this->clientClass . '();',
            '```',
            '',
            '## Errors',
            '',
            'Every error is a subclass of `' . $this->clientClass . 'Error`. Catch the specific one you',
            'expect, or the base for anything from this SDK:',
            '',
            '```php',
            'use ' . $this->namespace . '\\Core\\NotFoundError;',
            '',
            'try {',
            '    // ...',
            '} catch (NotFoundError $e) {',
            '    echo $e->status;   // 404',
            '}',
            '```',
            '',
            '---',
            '',
            $attribution,
        ];

        return ['path' => 'README.md', 'contents' => implode("\n", $lines) . "\n"];
    }

    /**
     * The test bootstrap: Composer's autoloader when it is there, a minimal PSR-4 one when it is not.
     *
     * Self-contained deliberately. Pointing PHPUnit at `vendor/autoload.php` meant the generated tests
     * could not run until someone had run `composer install` in the output directory — so a freshly
     * generated package's tests failed on the bootstrap, which reads as the tests being broken rather than
     * the package being uninstalled. Go's generated tests need no install, and there is no reason PHP's
     * should.
     *
     * Composer's autoloader is preferred when present, because it is the one a consumer's own tooling uses
     * and it resolves anything they have added.
     *
     * @return array{path: string, contents: string}
     */
    private function testBootstrapFile(): array
    {
        $namespace = str_replace('\\', '\\\\', $this->namespace);
        $contents = <<<PHPBOOT
<?php

declare(strict_types=1);

/**
 * Bootstrap for the generated per-operation tests.
 *
 * Uses Composer's autoloader when dependencies are installed, and a minimal PSR-4 one otherwise — so the
 * tests run in a freshly generated package with nothing installed but PHPUnit itself.
 */

\$composer = __DIR__ . '/../vendor/autoload.php';
if (is_file(\$composer)) {
    require \$composer;

    return;
}

spl_autoload_register(static function (string \$class): void {
    \$prefixes = [
        '{$namespace}\\\\Tests\\\\' => __DIR__ . '/',
        '{$namespace}\\\\' => __DIR__ . '/../src/',
    ];
    foreach (\$prefixes as \$prefix => \$base) {
        if (!str_starts_with(\$class, \$prefix)) {
            continue;
        }
        \$relative = substr(\$class, strlen(\$prefix));
        \$path = \$base . str_replace('\\\\', '/', \$relative) . '.php';
        if (is_file(\$path)) {
            require \$path;

            return;
        }
    }
});

PHPBOOT;

        return ['path' => 'tests/bootstrap.php', 'contents' => $contents];
    }

    /**
     * @return array{path: string, contents: string}
     */
    private function phpunitConfigFile(): array
    {
        $contents = <<<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!--
  Runs the generated per-operation tests.

  `tests/` only: the examples are scripts rather than test cases, and PHPStan is what checks those.
-->
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         bootstrap="tests/bootstrap.php"
         colors="true"
         cacheDirectory=".phpunit.cache">
  <testsuites>
    <testsuite name="operations">
      <directory>tests</directory>
    </testsuite>
  </testsuites>
</phpunit>

XML;

        return ['path' => 'phpunit.xml', 'contents' => $contents];
    }

    /**
     * @return array{path: string, contents: string}
     */
    private function phpstanConfigFile(): array
    {
        // `src` and `examples`: `vendor/` is other people's code, and `Core/` is included deliberately —
        // the vendored runtime is part of what ships, so it is held to the same level.
        //
        // `examples` is in scope because an example outside the gate is an example that rots. The first
        // version scoped to `src` alone and the gate passed while every example referenced three classes it
        // had not imported — a fatal error at run time, in the one language of the six with no compiler to
        // catch it. `tests` stays out: it imports PHPUnit, which the output directory need not have
        // installed, the same asymmetry the TypeScript target documents (SPEC.md §3.11).
        $contents = <<<'NEON'
parameters:
    level: 9
    paths:
        - src
        - examples

NEON;

        return ['path' => 'phpstan.neon', 'contents' => $contents];
    }

    /**
     * @return array{path: string, contents: string}
     */
    private function fixerConfigFile(): array
    {
        $contents = <<<'PHPCONF'
<?php

declare(strict_types=1);

// PER-CS2.0 is the current PSR-12 successor and what the ecosystem's tooling defaults to, so this package
// matches community style byte-for-byte rather than approximately.
//
// `setRiskyAllowed(false)`: no fixer here may change behaviour. The generator already writes
// `declare(strict_types=1)` in every file, so the one risky rule that would be useful is unnecessary.
return (new PhpCsFixer\Config())
    ->setRiskyAllowed(false)
    ->setRules([
        '@PER-CS2.0' => true,
        'ordered_imports' => ['sort_algorithm' => 'alpha'],
        'no_unused_imports' => true,
        'single_line_empty_body' => true,
        'trailing_comma_in_multiline' => ['elements' => ['arguments', 'arrays', 'parameters']],
    ])
    ->setFinder(PhpCsFixer\Finder::create()->in(__DIR__ . '/src')->name('*.php'));

PHPCONF;

        return ['path' => '.php-cs-fixer.php', 'contents' => $contents];
    }

    /**
     * The operation key a validation error names, e.g. `widgets.list`.
     *
     * @param array<string,mixed> $resource
     * @param array<string,mixed> $method
     */
    private function operationKey(array $resource, array $method): string
    {
        return implode('.', $this->tokensOf($resource['name'] ?? null))
            . '.' . Naming::camel($this->tokensOf($method['name'] ?? null));
    }

    /**
     * Render a descriptor as a PHP array literal.
     *
     * Hand-rendered rather than `var_export`, for one reason that earns it: `var_export` writes
     * `array(...)` with numeric keys spelled out, and a Stripe-sized table is tens of thousands of entries.
     * Short syntax and omitted keys are a meaningful difference in a file a consumer ships.
     *
     * @param array<string,mixed> $descriptor
     */
    private function renderDescriptor(array $descriptor): string
    {
        $parts = [];
        foreach ($descriptor as $key => $value) {
            $parts[] = $this->quote((string) $key) . ' => ' . $this->renderValue($value);
        }

        return '[' . implode(', ', $parts) . ']';
    }

    private function renderValue(mixed $value): string
    {
        if (is_array($value)) {
            $isList = array_is_list($value);
            $parts = [];
            foreach ($value as $key => $item) {
                $parts[] = ($isList ? '' : $this->quote((string) $key) . ' => ') . $this->renderValue($item);
            }

            return '[' . implode(', ', $parts) . ']';
        }
        if (is_string($value)) {
            return $this->quote($value);
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if ($value === null) {
            return 'null';
        }

        return (string) (is_int($value) || is_float($value) ? $value : 0);
    }

    /**
     * The descriptor table, as a class constant.
     *
     * A constant rather than a function returning a literal: PHP compiles a constant array once per request
     * and shares it, where a function body would rebuild it on every call. On a hot path validating a large
     * list response, that is the difference between free and measurable.
     *
     * Returns null when nothing is validated, so a spec whose responses are all untyped ships no table
     * rather than an empty one.
     *
     * @return ?array{path: string, contents: string}
     */
    private function schemaFile(): ?array
    {
        $table = $this->schemas->table();
        if ($table === []) {
            return null;
        }

        $builder = new Builder($this->namespace, [
            $this->brandNotice(),
            '',
            'Runtime validation descriptors.',
            '',
            'Data rather than generated checks: one hand-written walker in the runtime interprets this, which',
            'is more trustworthy than a validator generated per type and a fraction of the size.',
        ]);

        $source = Builder::docblock([
            'Descriptors for every type reachable from a response.',
            '',
            'Only reachable types are here. A spec\'s type graph is much larger than its response graph, and',
            'a descriptor for a shape the client can never receive is bytes every consumer ships for nothing.',
        ]);
        $source .= "final class Schemas\n{\n";
        $source .= '    /** @var array<string,array<string,mixed>> */' . "\n";
        $source .= "    public const TABLE = [\n";
        foreach ($table as $name => $descriptor) {
            $source .= '        ' . $this->quote($name) . ' => ' . $this->renderDescriptor($descriptor) . ",\n";
        }
        $source .= "    ];\n}";

        $builder->add($source);

        return ['path' => 'src/Schemas.php', 'contents' => $builder->render()];
    }

    /**
     * The `use (...)` list a validating page closure needs.
     *
     * An arrow function captures the enclosing scope automatically, but a validating closure has two
     * statements and so must be a `function`, which captures nothing implicitly. Building the list from the
     * signature rather than scraping the rendered query expression: the signature is the source of truth,
     * and a regex over generated text would silently miss a parameter the day the rendering changes.
     *
     * @param list<array<string,mixed>> $signature
     */
    private function closureCaptures(array $signature): string
    {
        // Every parameter, not just the query ones. A paginated method whose path is templated referenced
        // `$orgId` inside the closure and captured only `$options` — "Undefined variable", caught by
        // PHPStan on the first spec that had a paginated subresource. An unused capture is harmless; a
        // missing one is a runtime error.
        $names = ['$options'];
        foreach ($signature as $param) {
            $name = $param['name'] ?? null;
            if (is_string($name) && $name !== 'options') {
                $names[] = '$' . $name;
            }
        }

        return implode(', ', array_values(array_unique($names)));
    }

    /**
     * A dotted body path as a quoted PHP argument list.
     *
     * @param list<string> $path
     */
    private function quotedPath(array $path): string
    {
        return implode(', ', array_map(fn(string $segment): string => $this->quote($segment), $path));
    }

    /**
     * The model class a list field's elements decode to, or null when they are not a named object.
     *
     * @param array<string,mixed> $ref
     */
    private function namedObjectClass(array $ref): ?string
    {
        // Look through a nullable wrapper: `?list<Member>` decodes the same as `list<Member>`.
        if (($ref['kind'] ?? null) === 'nullable') {
            $ref = Json::obj($ref['inner'] ?? null);
        }
        if (($ref['kind'] ?? null) !== 'array') {
            return null;
        }
        $items = Json::obj($ref['items'] ?? null);
        if (($items['kind'] ?? null) !== 'named') {
            return null;
        }
        $id = Json::str($items['id'] ?? null);
        $type = Json::obj($this->types->types()[$id] ?? null);

        return ($type['kind'] ?? null) === 'object' ? $this->types->nameOf($id) : null;
    }

    /**
     * A name for the decoder's parameter that no property shadows.
     *
     * @param list<array{property: string, native: string, required: bool, summary: ?string, wire: string, itemClass?: ?string, element?: ?array<string,mixed>, mapValue?: ?array<string,mixed>}> $params
     */
    private function unshadowedArgName(array $params): string
    {
        $taken = [];
        foreach ($params as $param) {
            $taken[$param['property']] = true;
        }
        foreach (['data', 'payload', 'raw', 'input'] as $candidate) {
            if (!isset($taken[$candidate])) {
                return $candidate;
            }
        }

        // Exhausting four candidates means a model with fields called all of them, which no spec has —
        // but a suffix is still better than emitting code that does not work.
        $name = 'data';
        $suffix = 2;
        while (isset($taken[$name])) {
            $name = 'data' . $suffix++;
        }

        return $name;
    }

    /**
     * The phpdoc type describing what a method **actually returns**, not what the IR declares.
     *
     * These diverge in one place: an array whose elements are a union of named objects with no
     * discriminator. graft cannot decode those — `anyOf` means at least one branch matches, and picking is
     * guesswork — so the items stay raw decoded arrays. Documenting them as `list<Member|Invoice>` would be
     * a lie the typechecker rightly rejects, and `graft check` already reports the underlying ambiguity as
     * `T006` where the user can act on it.
     *
     * @param array<string,mixed> $ref
     */
    private function decodedDoc(array $ref): string
    {
        if (($ref['kind'] ?? null) === 'array') {
            $items = Json::obj($ref['items'] ?? null);
            if (($items['kind'] ?? null) === 'union' && $this->unionIsUndecodable($items)) {
                // `list<mixed>`, matching exactly what the decoder returns. Claiming
                // `list<array<...>>` would assert every item is an object, which a malformed response
                // can violate — and filtering to make it true would silently drop data.
                return 'list<mixed>';
            }
        }

        return $this->types->doc($ref);
    }

    /**
     * True when a union's branches cannot be told apart at runtime.
     *
     * A `discriminator` in the spec makes it decodable — that is exactly what §3.1.7 narrows member fields
     * to literals for. Without one, a union of two objects is indistinguishable to a decoder.
     *
     * @param array<string,mixed> $union
     */
    private function unionIsUndecodable(array $union): bool
    {
        if (Json::obj($union['discriminator'] ?? null) !== []) {
            return false;
        }
        foreach (Json::objects($union['variants'] ?? null) as $variant) {
            if (($variant['kind'] ?? null) === 'named') {
                return true;
            }
        }

        return false;
    }

    /**
     * The descriptor for one page item.
     *
     * @param array<string,mixed> $response
     * @return array<string,mixed>
     */
    private function paginatedItemDescriptor(array $response, string $paginationId): array
    {
        if (($response['kind'] ?? null) !== 'json') {
            return ['k' => 'any'];
        }
        $ref = Json::obj($response['type'] ?? null) ?: null;
        if ($ref === null) {
            return ['k' => 'any'];
        }
        $items = $this->itemsSourceFor($paginationId);
        if ($items !== null && ($items['kind'] ?? null) === 'body') {
            $ref = Json::obj($this->walkToField($ref, Json::strings($items['path'] ?? null)) ?? $ref);
        }
        if (($ref['kind'] ?? null) !== 'array') {
            return ['k' => 'any'];
        }
        $inner = Json::obj($ref['items'] ?? null) ?: null;

        return $inner === null ? ['k' => 'any'] : $this->schemas->describe($inner);
    }
}
