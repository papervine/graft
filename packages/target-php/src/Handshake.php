<?php

declare(strict_types=1);

namespace Graft\Target\Php;

/**
 * What this target tells the core about itself (SPEC.md §3.5).
 *
 * The flag the core probes with carries no project name on purpose: a target hardcodes it because it cannot
 * import the constant that owns it, which makes it a promise to third-party target authors rather than an
 * internal detail (§1.2).
 */
final class Handshake
{
    public const FLAG = '--sdk-target-protocol';

    /**
     * @return array<string,mixed>
     */
    public static function describe(): array
    {
        return [
            'name' => 'php',
            'displayName' => 'PHP',
            'version' => '0.0.0',
            // Kept in step with `packages/protocol/src/branding.ts`. A mismatch is a hard error in the
            // core rather than a warning, because a target reading an IR it does not understand produces a
            // subtly wrong SDK.
            'irVersions' => ['1.x'],
            /**
             * What this target actually emits — no more, and no less.
             *
             * `binary-responses` is declared because a binary or textual body is returned as the raw string,
             * which the `path_escaping` conformance scenario exercises. Under-declaring it would mislead
             * anyone reading this target as an example, which is the bug the TypeScript handshake had.
             *
             * Absent on purpose: `streaming`, because a streaming method is skipped with a warning rather
             * than emitted as something that cannot work; `sync-and-async`, because PHP has no asynchronous
             * HTTP to offer a second client for.
             */
            'capabilities' => [
                'pagination',
                'binary-responses',
                'multipart-requests',
                'read-write-split',
            ],
            'lineComment' => '//',
            'gates' => self::gates(),
        ];
    }

    /**
     * Verification gates for generated PHP, in the order that makes their output useful.
     *
     * `php -l` first: a syntax error makes every later tool's output noise, and it means the emitter is
     * broken rather than the spec being odd, so the message should be as blunt as possible.
     *
     * PHPStan at **level 9** because that is where it stops accepting `mixed`, which is the level that
     * actually holds generated code to the bar `AGENTS.md` sets. PHP has no generics, so a typed collection
     * is `array` plus a `@param list<Widget>` docblock — the phpdoc is the only place the element type
     * exists, and PHPStan is what makes it load-bearing rather than a comment (§3.3.7).
     *
     * Neither PHPStan nor php-cs-fixer ships with PHP, so both resolve from the generated package's own
     * `vendor/` and are marked `optional`: a consumer who has not run `composer install` should get a
     * generated SDK with a warning, not a failed generation.
     *
     * @return list<array<string,mixed>>
     */
    private static function gates(): array
    {
        $php = \PHP_BINARY;
        $gates = [
            [
                'name' => 'php -l',
                // `find` rather than a glob: a shell glob does not recurse, and `src/` is nested.
                'command' => ['sh', '-c', 'find src -name "*.php" -print0 | xargs -0 -n1 ' . escapeshellarg($php) . ' -l'],
                'kind' => 'verify',
            ],
        ];

        // Resolved from *this package's* dependencies, as absolute paths. Two reasons, and the second is
        // the one that was learned the hard way: the consumer's `vendor/` does not exist at generation
        // time, and `optional` cannot save a gate invoked through an interpreter — `php vendor/bin/phpstan`
        // spawns successfully and then `php` exits non-zero with "Could not open input file", which reads
        // as a real failure. A tool that is genuinely absent must produce no gate at all.
        $fixer = self::vendorBin('php-cs-fixer');
        if ($fixer !== null) {
            $gates[] = [
                'name' => 'php-cs-fixer',
                'command' => [$php, $fixer, 'fix', '--using-cache=no', '--no-interaction', '--quiet'],
                // A formatter's exit code is not a verdict on the output; see `Handshake.gates.kind`.
                'kind' => 'fix',
                'optional' => true,
            ];
        }

        $phpstan = self::vendorBin('phpstan');
        if ($phpstan !== null) {
            $gates[] = [
                'name' => 'phpstan (level 9)',
                'command' => [$php, $phpstan, 'analyse', '--no-progress', '--no-interaction'],
                // Never optional. Skipping the typechecker removes the guarantee the whole pipeline is
                // premised on, where skipping the formatter costs only cosmetics.
                'kind' => 'verify',
            ];
        }

        $phpunit = self::vendorBin('phpunit');
        if ($phpunit !== null) {
            $gates[] = [
                'name' => 'generated tests',
                'command' => [$php, $phpunit, '--no-progress', '--no-output'],
                'kind' => 'verify',
                // Optional, unlike PHPStan: PHPUnit has to be installed *in the output directory* for its
                // own autoloader to find the generated test classes, and a first generation into an empty
                // directory has run no `composer install`. Failing generation over an absent dev dependency
                // would make the feature a liability (SPEC.md §3.11).
                'optional' => true,
            ];
        }

        return $gates;
    }

    /** An executable in this package's own `vendor/bin`, or null when dependencies are not installed. */
    private static function vendorBin(string $name): ?string
    {
        foreach ([__DIR__ . '/../vendor/bin/', __DIR__ . '/../../../vendor/bin/'] as $dir) {
            $path = realpath($dir . $name);
            if ($path !== false && is_file($path)) {
                return $path;
            }
        }

        return null;
    }
}
