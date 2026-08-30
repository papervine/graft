<?php

declare(strict_types=1);

namespace Graft\Runtime\Tests;

use Graft\Runtime\ResponseValidationError;
use Graft\Runtime\Validate;
use Graft\Runtime\ValidationMode;
use PHPUnit\Framework\TestCase;

final class ValidateTest extends TestCase
{
    /**
     * @param array<string,mixed> $schema
     * @param array<string,mixed> $table
     * @return list<string>
     */
    private function check(mixed $value, array $schema, array $table = []): array
    {
        return Validate::check($value, $schema, $table);
    }

    public function testAcceptsMatchingPrimitives(): void
    {
        self::assertSame([], $this->check('x', ['k' => 'str']));
        self::assertSame([], $this->check(1, ['k' => 'int']));
        self::assertSame([], $this->check(1.5, ['k' => 'num']));
        self::assertSame([], $this->check(true, ['k' => 'bool']));
        self::assertSame([], $this->check(null, ['k' => 'null', 'i' => ['k' => 'str']]));
    }

    public function testNamesTheFieldAndBothTypes(): void
    {
        $problems = $this->check(
            ['id' => 42],
            ['k' => 'obj', 'f' => [['id', ['k' => 'str'], 1]]],
        );
        self::assertSame(['id should be a string but was an integer'], $problems);
    }

    public function testAcceptsAWholeFloatWhereAnIntegerIsDeclared(): void
    {
        // A JSON integer arrives as 1.0 from serializers with no integer type. Rejecting that would fail
        // on data that is actually correct.
        self::assertSame([], $this->check(1.0, ['k' => 'int']));
        self::assertNotSame([], $this->check(1.5, ['k' => 'int']));
    }

    public function testReportsAMissingRequiredFieldButNotAMissingOptionalOne(): void
    {
        $schema = ['k' => 'obj', 'f' => [['id', ['k' => 'str'], 1], ['name', ['k' => 'str']]]];
        self::assertSame(['id is missing'], $this->check(['name' => 'x'], $schema));
        self::assertSame([], $this->check(['id' => 'x'], $schema));
    }

    public function testNeverComplainsAboutUnknownFields(): void
    {
        // A server adding a field must not break a client. That is the whole point of an evolving API.
        self::assertSame([], $this->check(
            ['id' => 'x', 'brandNew' => 123],
            ['k' => 'obj', 'f' => [['id', ['k' => 'str'], 1]]],
        ));
    }

    public function testNeverChecksEnumMembership(): void
    {
        // Servers add enum values without warning; the open-enum rule exists so that is not a decode
        // failure. An enum is validated as its base type only.
        self::assertSame([], $this->check('a-value-added-later', ['k' => 'str']));
    }

    public function testTreatsAnEmptyArrayAsAValidEmptyMap(): void
    {
        // The PHP empty-map artifact, from the emitting side this time: a PHP backend serialises `{}` as
        // `[]`, and that is a valid empty map rather than a wrong type.
        self::assertSame([], $this->check([], ['k' => 'map', 'v' => ['k' => 'str']]));
    }

    public function testWalksArraysAndReportsTheIndex(): void
    {
        $problems = $this->check(['a', 2], ['k' => 'arr', 'i' => ['k' => 'str']]);
        self::assertSame(['[1] should be a string but was an integer'], $problems);
    }

    public function testAcceptsAnyBranchOfAUnionAndReportsOnceWhenNoneMatch(): void
    {
        $schema = ['k' => 'or', 'o' => [['k' => 'str'], ['k' => 'int']]];
        self::assertSame([], $this->check('x', $schema));
        self::assertSame([], $this->check(3, $schema));
        // One message, not one per branch: a union of five reporting five problems buries the real one.
        self::assertCount(1, $this->check(true, $schema));
    }

    public function testTerminatesOnASelfReferentialSchema(): void
    {
        // The cycle closes through the table rather than through recursion, so this is finite by
        // construction rather than by a depth cap.
        $table = ['Node' => ['k' => 'obj', 'f' => [['child', ['k' => 'ref', 'n' => 'Node']]]]];
        self::assertSame([], $this->check(
            ['child' => ['child' => ['child' => []]]],
            ['k' => 'ref', 'n' => 'Node'],
            $table,
        ));
    }

    public function testTreatsAMissingTableEntryAsAny(): void
    {
        // An incomplete table must not reject correct data.
        self::assertSame([], $this->check(['anything' => 1], ['k' => 'ref', 'n' => 'Absent']));
    }

    public function testEnforceThrowsInStrictModeAndIsSilentWhenOff(): void
    {
        $schema = ['k' => 'obj', 'f' => [['id', ['k' => 'str'], 1]]];
        Validate::enforce(['id' => 1], $schema, [], 'widgets.get', ValidationMode::Off);

        $this->expectException(ResponseValidationError::class);
        $this->expectExceptionMessageMatches('/widgets\.get/');
        Validate::enforce(['id' => 1], $schema, [], 'widgets.get', ValidationMode::Strict);
    }

    public function testAValidationErrorIsNotAnApiError(): void
    {
        // The server answered successfully; what failed is the contract between spec and implementation.
        // A caller catching ApiError to handle "the API said no" must not swallow this.
        // Read off the parent chain rather than asserted with instanceof or is_subclass_of: PHPStan
        // constant-folds both of those to always-true/always-false, which is the typechecker confirming
        // the hierarchy — but leaves nothing guarding a future change to it. `class_parents` it cannot
        // fold, so this stays a real test of the decision rather than a tautology.
        $parents = class_parents(ResponseValidationError::class);
        self::assertIsArray($parents);
        self::assertNotContains(\Graft\Runtime\ApiError::class, $parents);
        self::assertContains(\Graft\Runtime\SdkError::class, $parents);
    }
}
