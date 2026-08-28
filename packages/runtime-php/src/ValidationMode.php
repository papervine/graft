<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/** How strictly a response is checked against the shape the spec declared (SPEC.md §3.4.1.1). */
enum ValidationMode: string
{
    case Strict = 'strict';
    case Warn = 'warn';
    case Off = 'off';
}
