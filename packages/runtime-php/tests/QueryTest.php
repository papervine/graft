<?php

declare(strict_types=1);

namespace Graft\Runtime\Tests;

use Graft\Runtime\Query;
use PHPUnit\Framework\TestCase;

enum Kind: string
{
    case Member = 'member';
    case Invoice = 'invoice';
}

enum Level: int
{
    case Low = 1;
}

final class QueryTest extends TestCase
{
    public function testOmitsNullButKeepsFalse(): void
    {
        // `?active=false` is a meaningful filter; omitting the parameter is a different request. PHP's own
        // `http_build_query` renders false as the empty string, which loses that distinction.
        self::assertSame(['active' => ['false']], Query::flatten(['active' => false, 'other' => null]));
    }

    public function testRepeatsTheKeyForAnArray(): void
    {
        // `?tag=a&tag=b`, not `?tag[0]=a`, which is PHP-specific and rejected by most servers.
        self::assertSame(['tag' => ['a', 'b']], Query::flatten(['tag' => ['a', 'b']]));
        self::assertSame('https://x/y?tag=a&tag=b', Query::url('https://x', '/y', ['tag' => ['a', 'b']]));
    }

    public function testSendsNothingForAnEmptyArray(): void
    {
        self::assertSame([], Query::flatten(['tag' => []]));
    }

    public function testABackedEnumSendsItsValue(): void
    {
        // Found by the cross-language conformance suite: an enum fell through to `json_encode` and arrived
        // as `"member"` with literal quotes, where every other language sent `member`.
        self::assertSame(['kind' => ['member']], Query::flatten(['kind' => Kind::Member]));
        self::assertSame(['level' => ['1']], Query::flatten(['level' => Level::Low]));
        self::assertSame(['kind' => ['member', 'invoice']], Query::flatten(['kind' => [Kind::Member, Kind::Invoice]]));
    }

    public function testATimestampIsRfc3339(): void
    {
        $when = new \DateTimeImmutable('2026-01-02T03:04:05+00:00');
        self::assertSame(['since' => ['2026-01-02T03:04:05+00:00']], Query::flatten(['since' => $when]));
    }

    public function testPathParametersArePercentEncoded(): void
    {
        // An id containing a slash must not escape its segment and reach a different endpoint.
        self::assertSame('/orgs/a%2Fb/invoices/i1', Query::path('/orgs/{org}/invoices/{id}', ['org' => 'a/b', 'id' => 'i1']));
        // `rawurlencode`, not `urlencode`: the latter renders a space as `+`, which is correct in a query
        // string and wrong in a path.
        self::assertSame('/x/a%20b', Query::path('/x/{k}', ['k' => 'a b']));
    }
}
