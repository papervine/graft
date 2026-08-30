<?php

declare(strict_types=1);

namespace Graft\Target\Php;

/**
 * Turning IR token sequences into PHP identifiers.
 *
 * Names arrive as lowercase token sequences (`["user","id"]`) precisely so each target applies its own
 * convention (SPEC.md §3.2). PHP's is PSR-1 and PSR-12: `PascalCase` for classes, `camelCase` for methods
 * and properties.
 *
 * Unlike Go, PHP does not capitalise initialisms wholly — `getApiKey`, not `getAPIKey` — which is one of
 * the places the token-sequence design pays off: the same IR produces `UserID` in Go and `userId` here
 * with no coordination.
 */
final class Naming
{
    /**
     * Words PHP reserves. A generated identifier colliding with one of these is a syntax error, not a
     * style problem, so the list is exhaustive for 8.4 rather than a best guess.
     *
     * @var list<string>
     */
    private const RESERVED = [
        'abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch', 'class', 'clone',
        'const', 'continue', 'declare', 'default', 'do', 'echo', 'else', 'elseif', 'empty',
        'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'enum', 'eval',
        'exit', 'extends', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto',
        'if', 'implements', 'include', 'include_once', 'instanceof', 'insteadof', 'interface', 'isset',
        'list', 'match', 'namespace', 'new', 'or', 'print', 'private', 'protected', 'public',
        'readonly', 'require', 'require_once', 'return', 'static', 'switch', 'throw', 'trait', 'try',
        'unset', 'use', 'var', 'while', 'xor', 'yield',
        // Not reserved as identifiers but reserved as *type* names, which a class cannot be called.
        'bool', 'float', 'int', 'iterable', 'mixed', 'never', 'null', 'object', 'string', 'void',
        'false', 'true', 'self', 'parent',
    ];

    /**
     * @param list<string> $tokens
     */
    public static function pascal(array $tokens): string
    {
        $out = '';
        foreach ($tokens as $token) {
            $out .= self::capitalise($token);
        }

        return self::safeClass($out);
    }

    /**
     * @param list<string> $tokens
     */
    public static function camel(array $tokens): string
    {
        $pascal = '';
        foreach ($tokens as $token) {
            $pascal .= self::capitalise($token);
        }

        return self::safeMember(lcfirst($pascal));
    }

    /**
     * A property name, which follows the wire name only when it has to.
     *
     * A wire key that is not a valid PHP identifier — `_id`, `2fa`, `content-type` — still has to be
     * readable, so the property is named idiomatically and the mapping to the wire happens in the decoder.
     * Never renaming would produce `$widget->{'content-type'}`, which is legal and awful.
     *
     * @param list<string> $tokens
     */
    public static function property(array $tokens): string
    {
        return self::camel($tokens);
    }

    /** Class-name-safe: a leading digit or a reserved word gets a prefix rather than a mangled name. */
    private static function safeClass(string $name): string
    {
        if ($name === '') {
            return 'Value';
        }
        if (preg_match('/^\d/', $name) === 1) {
            // `2FactorAuth` is not a class name. Prefixed rather than stripped, because the digit is
            // usually meaningful.
            return 'N' . $name;
        }
        if (in_array(strtolower($name), self::RESERVED, true)) {
            return $name . 'Type';
        }

        return $name;
    }

    private static function safeMember(string $name): string
    {
        if ($name === '') {
            return 'value';
        }
        if (preg_match('/^\d/', $name) === 1) {
            return 'n' . ucfirst($name);
        }
        // Method and property names may be reserved words in PHP — `$obj->list` and `$obj->class()` are
        // both legal — so only the ones that are genuinely ambiguous are renamed. Kept minimal: renaming
        // a member the spec named `list` would be gratuitous.
        return $name;
    }

    private static function capitalise(string $token): string
    {
        // A token may itself contain characters PHP forbids, e.g. a wire key like `content-type` that was
        // never tokenised. Stripped rather than escaped: an identifier has to be an identifier.
        $clean = preg_replace('/[^A-Za-z0-9]/', '', $token) ?? '';

        return ucfirst($clean);
    }

    /**
     * A PSR-4 namespace from a package name.
     *
     * `acme/widget-sdk` becomes `Acme\WidgetSdk`, which is the mapping Composer's own convention implies
     * and what every PHP consumer will expect from that package name.
     */
    public static function namespaceFor(string $packageName): string
    {
        $parts = [];
        foreach (explode('/', $packageName) as $segment) {
            $words = preg_split('/[^A-Za-z0-9]+/', $segment) ?: [];
            $joined = '';
            foreach ($words as $word) {
                $joined .= ucfirst(strtolower($word));
            }
            if ($joined !== '') {
                $parts[] = $joined;
            }
        }

        return $parts === [] ? 'Sdk' : implode('\\', $parts);
    }
}
