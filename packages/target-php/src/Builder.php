<?php

declare(strict_types=1);

namespace Besdk\Target\Php;

/**
 * A structured code builder for PHP source.
 *
 * Not `nikic/php-parser`, and this is the third target to reach the same conclusion (SPEC.md §3.3.4 states
 * it as a rule): emit through a language's AST only when its AST library is designed for *synthesis*.
 * `php-parser` is an analysis library — its pretty-printer normalises formatting in ways that fight
 * `php-cs-fixer`, and comment attachment has the same fragility that disqualified `go/ast`.
 *
 * So: build a model of declarations, render to text, and let `php-cs-fixer` decide layout. Because the
 * fixer *is* the ecosystem's formatter, output matches community style byte-for-byte rather than
 * approximately — which is the property "no string templates" is really about, along with managed imports
 * and deduplicated types, both of which this builder handles.
 */
final class Builder
{
    /** @var array<string,true> fully-qualified names to import, deduplicated */
    private array $imports = [];

    /** @var list<string> rendered declarations, in order */
    private array $declarations = [];

    /**
     * @param list<string> $fileDoc lines of the file-level docblock, without the comment syntax
     */
    public function __construct(
        private readonly string $namespace,
        private readonly array $fileDoc = [],
    ) {}

    /**
     * Register a `use` statement.
     *
     * Deduplicated and sorted at render time, so callers add freely without tracking what they already
     * added — the thing string templates cannot do.
     */
    public function import(string $fqn): void
    {
        $trimmed = ltrim($fqn, '\\');
        // A class in this file's own namespace needs no import, and PHP warns about importing one.
        if ($trimmed === '' || str_starts_with($trimmed, $this->namespace . '\\')) {
            $rest = substr($trimmed, strlen($this->namespace) + 1);
            if (!str_contains($rest, '\\')) {
                return;
            }
        }
        $this->imports[$trimmed] = true;
    }

    public function add(string $declaration): void
    {
        $this->declarations[] = rtrim($declaration);
    }

    public function render(): string
    {
        $out = "<?php\n\ndeclare(strict_types=1);\n\n";
        if ($this->fileDoc !== []) {
            $out .= "/**\n";
            foreach ($this->fileDoc as $line) {
                $out .= $line === '' ? " *\n" : ' * ' . $line . "\n";
            }
            $out .= " */\n\n";
        }
        $out .= 'namespace ' . $this->namespace . ";\n";

        $imports = array_keys($this->imports);
        sort($imports);
        if ($imports !== []) {
            $out .= "\n";
            foreach ($imports as $import) {
                $out .= 'use ' . $import . ";\n";
            }
        }

        foreach ($this->declarations as $declaration) {
            $out .= "\n" . $declaration . "\n";
        }

        return $out;
    }

    /**
     * Wrap prose as a docblock at the given indentation.
     *
     * @param list<string> $lines
     */
    public static function docblock(array $lines, int $indent = 0): string
    {
        $lines = array_values(array_filter($lines, static fn(string $line): bool => $line !== "\0"));
        if ($lines === []) {
            return '';
        }
        $pad = str_repeat(' ', $indent);
        $out = $pad . "/**\n";
        foreach ($lines as $line) {
            $out .= $line === '' ? $pad . " *\n" : $pad . ' * ' . $line . "\n";
        }

        return $out . $pad . " */\n";
    }

    /**
     * Collapse prose from a spec into docblock lines.
     *
     * Specs are careless with whitespace — a description may be one line or forty, with hard wraps mid
     * sentence — so it is normalised and re-wrapped rather than passed through. `*​/` is escaped because a
     * description containing it would close the docblock early and produce a syntax error, which is not
     * hypothetical: it happens in specs that document glob patterns.
     *
     * @return list<string>
     */
    public static function prose(?string $summary, ?string $description = null, int $width = 100): array
    {
        $lines = [];
        foreach ([$summary, $description] as $index => $text) {
            $clean = trim((string) $text);
            if ($clean === '') {
                continue;
            }
            if ($index === 1 && $clean === trim((string) $summary)) {
                continue;
            }
            if ($lines !== []) {
                $lines[] = '';
            }
            $collapsed = preg_replace('/\s+/', ' ', str_replace('*/', '*\\/', $clean)) ?? $clean;
            foreach (explode("\n", wordwrap($collapsed, $width, "\n", false)) as $line) {
                $lines[] = $line;
            }
        }

        return $lines;
    }
}
