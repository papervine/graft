<?php

declare(strict_types=1);

namespace Besdk\Target\Php\Tests;

use Besdk\Target\Php\Handshake;
use PHPUnit\Framework\TestCase;

final class HandshakeTest extends TestCase
{
    public function testDeclaresWhatItActuallyEmits(): void
    {
        $capabilities = Handshake::describe()['capabilities'];
        self::assertIsArray($capabilities);
        self::assertContains('pagination', $capabilities);
        // A binary or textual body is returned as the raw string; the `path_escaping` conformance scenario
        // exercises it.
        self::assertContains('binary-responses', $capabilities);
        self::assertContains('read-write-split', $capabilities);
        // Multipart bodies are encoded by `Multipart`, with the boundary travelling on the content type.
        self::assertContains('multipart-requests', $capabilities);
    }

    public function testDoesNotClaimWhatItSkips(): void
    {
        $capabilities = Handshake::describe()['capabilities'];
        self::assertIsArray($capabilities);
        // A streaming method is skipped with a warning rather than emitted as something that cannot work.
        self::assertNotContains('streaming', $capabilities);
        // PHP has no asynchronous HTTP to offer a second client for.
        self::assertNotContains('sync-and-async', $capabilities);
    }

    public function testDeclaresGatesWithTheLinterFirst(): void
    {
        $gates = Handshake::describe()['gates'];
        self::assertIsArray($gates);
        $names = [];
        foreach ($gates as $gate) {
            self::assertIsArray($gate);
            $names[] = is_string($gate['name'] ?? null) ? $gate['name'] : '';
        }
        // `php -l` first: a syntax error makes every later tool's output noise.
        self::assertSame('php -l', $names[0]);
        self::assertContains('phpstan (level 9)', $names);
    }

    public function testNeverMarksTheTypecheckerOptional(): void
    {
        $gates = Handshake::describe()['gates'];
        self::assertIsArray($gates);
        foreach ($gates as $gate) {
            self::assertIsArray($gate);
            if (str_contains(is_string($gate['name'] ?? null) ? $gate['name'] : '', 'phpstan')) {
                // Skipping the formatter costs cosmetics; skipping the typechecker removes the guarantee
                // the whole pipeline is premised on.
                self::assertNotSame(true, $gate['optional'] ?? false);
            }
        }
    }

    public function testTheProtocolFlagCarriesNoProjectName(): void
    {
        // A target hardcodes this flag because it cannot import the constant that owns it, which makes it a
        // promise to third-party target authors rather than an internal detail (SPEC.md §1.2).
        self::assertStringNotContainsStringIgnoringCase('besdk', Handshake::FLAG);
    }
}
