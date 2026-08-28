<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/** The response arrived but was not the JSON it claimed to be. */
final class DecodeError extends SdkError {}
