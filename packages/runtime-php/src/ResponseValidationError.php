<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/**
 * A response did not match the shape the spec declared.
 *
 * Deliberately **not** an `ApiError`. The server answered successfully; what failed is the contract
 * between the spec and the implementation, and a caller catching `ApiError` to handle *the API saying no*
 * should not accidentally swallow this (SPEC.md §3.4.1.1).
 */
final class ResponseValidationError extends SdkError
{
    /**
     * @param list<string> $problems
     */
    public function __construct(
        public readonly string $operation,
        public readonly array $problems,
    ) {
        $first = $problems[0] ?? 'the response did not match the declared shape';
        $extra = count($problems) > 1 ? sprintf(' (and %d more)', count($problems) - 1) : '';
        parent::__construct(sprintf(
            "%s: the response did not match the API's declared shape — %s%s",
            $operation,
            $first,
            $extra,
        ));
    }
}
