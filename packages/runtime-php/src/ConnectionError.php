<?php

declare(strict_types=1);

namespace Graft\Runtime;

/** The request never completed: DNS, TLS, connection reset. No status, because none arrived. */
class ConnectionError extends SdkError {}
