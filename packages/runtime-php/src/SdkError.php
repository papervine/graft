<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/**
 * The base of every error this runtime raises.
 *
 * Named for its role, never for the generator. A generator-branded class would put this tool's name in
 * every consumer's catch block, making a rename here a breaking change for every SDK ever produced
 * (SPEC.md §1.2). Generated code aliases this to `<ClientName>Error`, so the brand a user sees is
 * their own.
 *
 * An abstract class rather than an interface: `catch` needs a type, and every subclass here genuinely
 * shares the message-and-cause machinery `\Exception` provides.
 */
abstract class SdkError extends \RuntimeException {}
