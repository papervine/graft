<?php

declare(strict_types=1);

namespace Besdk\Runtime;

/**
 * Encoding a request body as `multipart/form-data`.
 *
 * Its own file because the framing is fiddly and unforgiving: a boundary that appears in the content, a
 * missing `filename=`, or a header set without the boundary all produce a request the server cannot parse,
 * and none of them is visible from the client side.
 *
 * Unlike every other runtime here, PHP cannot tell a file from a text field by *type* — a `format: binary`
 * field is a `string`, the same as a name. So the caller passes the binary field names, which the IR
 * already knows. That is IR data rather than a judgment: deciding *which* type means "file" is the shared
 * decision, and in TypeScript, Python, and Go it is answered by `Blob`, `bytes`, and `[]byte`. PHP has no
 * such type, so the answer has to arrive from outside.
 */
final class Multipart
{
    /**
     * Encode a body, returning the payload and the content type that describes it.
     *
     * Both together, because the content type carries the boundary and a boundary invented separately from
     * the body it delimits is the one mistake that cannot be recovered from.
     *
     * @param  list<string> $fileFields wire names whose values are file contents
     * @return array{0: string, 1: string} the encoded body and its content type
     */
    public static function encode(mixed $body, array $fileFields = []): array
    {
        $fields = json_decode(json_encode($body, \JSON_THROW_ON_ERROR) ?: '{}', true);
        if (!is_array($fields)) {
            $fields = [];
        }

        $boundary = self::boundary();
        $files = array_flip($fileFields);
        $out = '';
        foreach ($fields as $key => $value) {
            // Null is omitted rather than sent as an empty part, which a server reads as a real value —
            // the same rule `Query` and `Form` follow.
            if ($value === null) {
                continue;
            }
            $name = (string) $key;
            if (isset($files[$name])) {
                // The filename is the field name, which is the best available guess: the spec carries
                // none, and a server matching on `filename=` sees nothing without one.
                $out .= "--{$boundary}\r\n";
                $out .= 'Content-Disposition: form-data; name="' . $name . '"; filename="' . $name . "\"\r\n";
                $out .= "Content-Type: application/octet-stream\r\n\r\n";
                $out .= Form::scalarFor($value) . "\r\n";

                continue;
            }
            if (is_array($value) && array_is_list($value)) {
                foreach ($value as $item) {
                    if ($item === null) {
                        continue;
                    }
                    $out .= self::field($boundary, $name, Form::scalarFor($item));
                }

                continue;
            }
            $out .= self::field($boundary, $name, Form::scalarFor($value));
        }
        $out .= "--{$boundary}--\r\n";

        return [$out, 'multipart/form-data; boundary=' . $boundary];
    }

    /** One ordinary form field as a part. */
    private static function field(string $boundary, string $name, string $value): string
    {
        return "--{$boundary}\r\n"
            . 'Content-Disposition: form-data; name="' . $name . "\"\r\n\r\n"
            . $value . "\r\n";
    }

    /**
     * A boundary unlikely to occur in any payload.
     *
     * Random rather than fixed: a fixed boundary appearing inside an uploaded file would truncate the
     * request at that point, and a file is exactly the content most likely to contain arbitrary bytes.
     */
    private static function boundary(): string
    {
        return '----formdata' . bin2hex(random_bytes(16));
    }
}
