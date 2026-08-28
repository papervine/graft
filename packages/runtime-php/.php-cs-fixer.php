<?php

declare(strict_types=1);

/**
 * Formatting for the hand-written PHP runtime, and the same rules the generated SDK is held to.
 *
 * PER-CS2.0 is the current PSR-12 successor and what the ecosystem's tooling defaults to, so generated
 * code matches community style byte-for-byte rather than approximately (`AGENTS.md`).
 */
return (new PhpCsFixer\Config())
    ->setRiskyAllowed(false)
    ->setRules([
        '@PER-CS2.0' => true,
        // `declare_strict_types` is deliberately absent: php-cs-fixer classes it as risky because adding
        // it changes behaviour. The generator emits it in every file, so the fixer never needs to, and
        // keeping `setRiskyAllowed(false)` means no fixer here can alter semantics.
        'ordered_imports' => ['sort_algorithm' => 'alpha'],
        'no_unused_imports' => true,
        'single_line_empty_body' => true,
        'trailing_comma_in_multiline' => ['elements' => ['arguments', 'arrays', 'parameters']],
    ])
    ->setFinder(
        PhpCsFixer\Finder::create()
            ->in([__DIR__ . '/src', __DIR__ . '/tests'])
            ->name('*.php'),
    );
