#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * The PHP conformance driver.
 *
 * Runs every shared scenario against the mock server using the *generated* SDK, and prints what it observed
 * as JSON on stdout. The runner compares that against the scenario expectations and against the other
 * languages' drivers.
 *
 * Calls are written natively — `$client->orgs->listMembers('o1', limit: 2)` — because the point is that
 * idiomatic code in each language produces identical wire behaviour. A data-driven driver dispatching on
 * operation names would prove nothing about idiom.
 *
 * Usage: php php_driver.php <baseURL>
 */

$root = dirname(__DIR__, 3);
require $root . '/sdks/kitchen-sink-php/vendor/autoload.php';

use Acme\KitchenSink\Core\BadRequestError;
use Acme\KitchenSink\Core\InternalServerError;
use Acme\KitchenSink\Core\NotFoundError;
use Acme\KitchenSink\Core\RequestOptions;
use Acme\KitchenSink\Core\ResponseValidationError;
use Acme\KitchenSink\KitchenSink;

if ($argc < 2) {
    fwrite(\STDERR, "usage: php_driver.php <baseURL>\n");
    exit(2);
}
$baseUrl = $argv[1];

/** A client pinned to one scenario, so the server knows which script to replay. */
function client(string $scenario, int $maxRetries = 0): KitchenSink
{
    global $baseUrl;

    // An API key, not a bearer token: this spec declares only `X-Api-Key`, so there is no `token`
    // parameter on the generated client.
    return new KitchenSink(
        apiKey: 'key_conformance',
        baseUrl: $baseUrl,
        maxRetries: $maxRetries,
        defaultHeaders: ['X-Scenario' => $scenario],
    );
}

/**
 * The first path a validation error reports.
 *
 * Each runtime words its message differently; the *path* is the part that must agree across languages, so
 * the comparison is about behaviour rather than about each library's formatting.
 */
function firstPath(ResponseValidationError $error): string
{
    $problem = $error->problems[0] ?? '';
    $space = strpos($problem, ' ');

    return $space === false ? $problem : substr($problem, 0, $space);
}

$scenarios = [
    'list_categories' => static function (): array {
        $categories = client('list_categories')->categories->list();

        return [
            'count' => (string) count($categories),
            'first_slug' => (string) $categories[0]->slug,
            'second_name' => (string) $categories[1]->name,
        ];
    },

    'paginate_members' => static function (): array {
        $emails = [];
        foreach (client('paginate_members')->orgs->listMembers('o1', limit: 2) as $member) {
            $emails[] = $member->email;
        }

        return ['emails' => implode(',', $emails), 'count' => (string) count($emails)];
    },

    'query_serialization' => static function (): array {
        // `since` is deliberately omitted: an absent optional parameter must not reach the wire at all.
        $results = client('query_serialization')->search->query(
            q: 'sprocket',
            kind: \Acme\KitchenSink\QueryKind::Member,
        );

        return ['count' => (string) count($results)];
    },

    'path_escaping' => static function (): array {
        $pdf = client('path_escaping')->orgs->invoices()->downloadPdf('a/b', 'i1');

        return ['byte_length' => (string) strlen($pdf)];
    },

    'error_404' => static function (): array {
        try {
            // Draining is required: the paginator is lazy, so the request happens on iteration.
            iterator_to_array(client('error_404')->orgs->listMembers('missing'), false);
        } catch (NotFoundError $error) {
            return [
                'error_kind' => 'not_found',
                'status' => (string) $error->status,
                'message' => $error->getMessage(),
                'request_id' => (string) $error->requestId,
            ];
        } catch (Throwable $error) {
            return ['error_kind' => 'wrong:' . $error::class];
        }

        return ['error_kind' => 'none'];
    },

    'retry_then_success' => static function (): array {
        // An idempotency key, because a POST without one is no longer retried.
        $receipt = client('retry_then_success', 2)->events->publish(
            body: ['type' => 'widget.created'],
            options: new RequestOptions(idempotencyKey: 'conformance_1'),
        );

        return [
            'accepted' => $receipt->accepted ? 'true' : 'false',
            'event_id' => (string) $receipt->eventId,
        ];
    },

    'no_retry_without_idempotency_key' => static function (): array {
        try {
            client('no_retry_without_idempotency_key', 2)->events->publish(body: ['type' => 'widget.created']);
        } catch (InternalServerError) {
            return ['error_kind' => 'server_error'];
        } catch (Throwable $error) {
            return ['error_kind' => 'wrong:' . $error::class];
        }

        return ['error_kind' => 'none'];
    },

    'no_retry_on_400' => static function (): array {
        try {
            client('no_retry_on_400', 2)->events->publish(body: ['type' => 'widget.created']);
        } catch (BadRequestError) {
            return ['error_kind' => 'bad_request'];
        } catch (Throwable $error) {
            return ['error_kind' => 'wrong:' . $error::class];
        }

        return ['error_kind' => 'none'];
    },

    'validation_catches_a_broken_contract' => static function (): array {
        try {
            client('validation_catches_a_broken_contract')->categories->list();
        } catch (ResponseValidationError $error) {
            return ['error_kind' => 'validation', 'path' => firstPath($error)];
        } catch (Throwable $error) {
            return ['error_kind' => 'wrong:' . $error::class];
        }

        return ['error_kind' => 'none'];
    },

    'validation_on_a_paginated_response' => static function (): array {
        try {
            iterator_to_array(
                client('validation_on_a_paginated_response')->orgs->listMembers('o1'),
                false,
            );
        } catch (ResponseValidationError $error) {
            // The field, not the full path: each language indexes the enclosing list differently, and the
            // field is what the comparison is about.
            $path = firstPath($error);
            $dot = strrpos($path, '.');

            return ['error_kind' => 'validation', 'path' => $dot === false ? $path : substr($path, $dot + 1)];
        } catch (Throwable $error) {
            return ['error_kind' => 'wrong:' . $error::class];
        }

        return ['error_kind' => 'none'];
    },

    'validation_allows_an_additive_field' => static function (): array {
        $categories = client('validation_allows_an_additive_field')->categories->list();

        return ['count' => (string) count($categories), 'first_slug' => (string) $categories[0]->slug];
    },

    'text_response' => static function (): array {
        $csv = client('text_response')->reports->exportUsage();
        $lines = explode("\n", rtrim($csv, "\n"));

        return ['text_starts_with' => $lines[0], 'line_count' => (string) count($lines)];
    },
];

$observed = [];
foreach ($scenarios as $name => $run) {
    try {
        $observed[$name] = $run();
    } catch (Throwable $error) {
        // A driver reports failures, never raises: one broken scenario must not hide the other eleven.
        $observed[$name] = ['_error' => $error::class . ': ' . $error->getMessage()];
    }
}

echo json_encode(
    ['language' => 'php', 'observed' => $observed],
    \JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES | \JSON_THROW_ON_ERROR,
);
