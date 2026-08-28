import com.acme.kitchensink.Category;
import com.acme.kitchensink.KitchenSink;
import com.acme.kitchensink.Member;
import com.acme.kitchensink.QueryKind;
import com.acme.kitchensink.core.BadRequestException;
import com.acme.kitchensink.core.InternalServerException;
import com.acme.kitchensink.core.Json;
import com.acme.kitchensink.core.NotFoundException;
import com.acme.kitchensink.core.RequestOptions;
import com.acme.kitchensink.core.ResponseValidationException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * The Java conformance driver.
 *
 * <p>Runs every shared scenario against the mock server using the <em>generated</em> SDK, and prints what it
 * observed as JSON on stdout. The runner compares that against the scenario expectations and against the other
 * languages' drivers.
 *
 * <p>Calls are written natively — {@code client.orgs().listMembers("o1", null, 2L)} — because the point is that
 * idiomatic code in each language produces identical wire behaviour. A data-driven driver dispatching on
 * operation names would prove nothing about idiom.
 *
 * <p>Usage: {@code java Driver <baseURL>}
 */
public final class Driver {

  private static String baseUrl;

  private Driver() {}

  /** A client pinned to one scenario, so the server knows which script to replay. */
  private static KitchenSink client(String scenario, int maxRetries) {
    // An API key, not a bearer token: this spec declares only `X-Api-Key`, so there is no `token` setter on
    // the generated builder.
    return KitchenSink.builder()
        .baseUrl(baseUrl)
        .apiKey("key_conformance")
        .maxRetries(maxRetries)
        .defaultHeaders(Map.of("X-Scenario", scenario))
        .build();
  }

  /**
   * The first path a validation failure reports.
   *
   * <p>Each runtime words its message differently; the <em>path</em> is the part that must agree across
   * languages, so the comparison is about behaviour rather than each library's formatting.
   */
  private static String firstPath(ResponseValidationException error) {
    String problem = error.problems().isEmpty() ? "" : error.problems().get(0);
    int space = problem.indexOf(' ');
    return space < 0 ? problem : problem.substring(0, space);
  }

  public static void main(String[] args) {
    if (args.length < 1) {
      System.err.println("usage: Driver <baseURL>");
      System.exit(2);
      return;
    }
    baseUrl = args[0];

    Map<String, Supplier<Map<String, String>>> scenarios = new LinkedHashMap<>();

    scenarios.put(
        "list_categories",
        () -> {
          List<Category> categories = client("list_categories", 0).categories().list();
          return Map.of(
              "count", String.valueOf(categories.size()),
              "first_slug", String.valueOf(categories.get(0).slug()),
              "second_name", String.valueOf(categories.get(1).name()));
        });

    scenarios.put(
        "paginate_members",
        () -> {
          List<String> emails = new ArrayList<>();
          for (Member member : client("paginate_members", 0).orgs().listMembers("o1", null, 2L)) {
            emails.add(member.email());
          }
          return Map.of("emails", String.join(",", emails), "count", String.valueOf(emails.size()));
        });

    scenarios.put(
        "query_serialization",
        () -> {
          // `since` is deliberately null: an absent optional parameter must not reach the wire at all.
          List<Object> results =
              client("query_serialization", 0).search().query("sprocket", QueryKind.MEMBER, null);
          return Map.of("count", String.valueOf(results.size()));
        });

    scenarios.put(
        "path_escaping",
        () -> {
          String pdf = client("path_escaping", 0).orgs().invoices().downloadPdf("a/b", "i1");
          return Map.of("byte_length", String.valueOf(pdf.length()));
        });

    scenarios.put(
        "error_404",
        () -> {
          try {
            // Draining is required: the paginator is lazy, so the request happens on iteration.
            client("error_404", 0).orgs().listMembers("missing", null, null).all();
          } catch (NotFoundException error) {
            return Map.of(
                "error_kind", "not_found",
                "status", String.valueOf(error.statusCode()),
                "message", error.getMessage(),
                "request_id", String.valueOf(error.requestId()));
          } catch (RuntimeException error) {
            return Map.of("error_kind", "wrong:" + error.getClass().getSimpleName());
          }
          return Map.of("error_kind", "none");
        });

    scenarios.put(
        "retry_then_success",
        () -> {
          // An idempotency key, because a POST without one is no longer retried.
          var receipt =
              client("retry_then_success", 2)
                  .events()
                  .publish(
                      Map.of("type", "widget.created"),
                      RequestOptions.builder().idempotencyKey("conformance_1").build());
          return Map.of(
              "accepted", String.valueOf(receipt.accepted()),
              "event_id", String.valueOf(receipt.eventId()));
        });

    scenarios.put(
        "no_retry_without_idempotency_key",
        () -> {
          try {
            client("no_retry_without_idempotency_key", 2)
                .events()
                .publish(Map.of("type", "widget.created"));
          } catch (InternalServerException error) {
            return Map.of("error_kind", "server_error");
          } catch (RuntimeException error) {
            return Map.of("error_kind", "wrong:" + error.getClass().getSimpleName());
          }
          return Map.of("error_kind", "none");
        });

    scenarios.put(
        "no_retry_on_400",
        () -> {
          try {
            client("no_retry_on_400", 2).events().publish(Map.of("type", "widget.created"));
          } catch (BadRequestException error) {
            return Map.of("error_kind", "bad_request");
          } catch (RuntimeException error) {
            return Map.of("error_kind", "wrong:" + error.getClass().getSimpleName());
          }
          return Map.of("error_kind", "none");
        });

    scenarios.put(
        "validation_catches_a_broken_contract",
        () -> {
          try {
            client("validation_catches_a_broken_contract", 0).categories().list();
          } catch (ResponseValidationException error) {
            return Map.of("error_kind", "validation", "path", firstPath(error));
          } catch (RuntimeException error) {
            return Map.of("error_kind", "wrong:" + error.getClass().getSimpleName());
          }
          return Map.of("error_kind", "none");
        });

    scenarios.put(
        "validation_on_a_paginated_response",
        () -> {
          try {
            client("validation_on_a_paginated_response", 0).orgs().listMembers("o1", null, null).all();
          } catch (ResponseValidationException error) {
            // The field, not the full path: each language indexes the enclosing list differently, and the
            // field is what the comparison is about.
            String path = firstPath(error);
            int dot = path.lastIndexOf('.');
            return Map.of("error_kind", "validation", "path", dot < 0 ? path : path.substring(dot + 1));
          } catch (RuntimeException error) {
            return Map.of("error_kind", "wrong:" + error.getClass().getSimpleName());
          }
          return Map.of("error_kind", "none");
        });

    scenarios.put(
        "validation_allows_an_additive_field",
        () -> {
          List<Category> categories =
              client("validation_allows_an_additive_field", 0).categories().list();
          return Map.of(
              "count", String.valueOf(categories.size()),
              "first_slug", String.valueOf(categories.get(0).slug()));
        });

    scenarios.put(
        "text_response",
        () -> {
          String csv = client("text_response", 0).reports().exportUsage();
          String[] lines = csv.stripTrailing().split("\n");
          return Map.of("text_starts_with", lines[0], "line_count", String.valueOf(lines.length));
        });

    Map<String, Object> observed = new LinkedHashMap<>();
    scenarios.forEach(
        (name, run) -> {
          try {
            observed.put(name, run.get());
          } catch (RuntimeException error) {
            // A driver reports failures, never raises: one broken scenario must not hide the other eleven.
            observed.put(
                name,
                Map.of("_error", error.getClass().getSimpleName() + ": " + error.getMessage()));
          }
        });

    Map<String, Object> output = new LinkedHashMap<>();
    output.put("language", "java");
    output.put("observed", observed);
    System.out.println(Json.write(output));
  }
}
