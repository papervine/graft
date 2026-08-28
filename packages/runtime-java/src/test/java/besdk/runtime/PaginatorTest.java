package besdk.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class PaginatorTest {

  /** Records the parameters each page request was made with. */
  private static final class Recorder implements Paginator.Fetcher {
    final List<Map<String, Object>> calls = new ArrayList<>();
    private final List<Page.Raw> pages;
    private int index;

    Recorder(List<Page.Raw> pages) {
      this.pages = pages;
    }

    @Override
    public Page.Raw fetch(Map<String, Object> params) {
      calls.add(params);
      return index < pages.size()
          ? pages.get(index++)
          : new Page.Raw(List.of(), new HttpResponseSpec(200, "[]", Map.of()));
    }
  }

  private static Page.Raw raw(Object body) {
    return new Page.Raw(body, new HttpResponseSpec(200, "", Map.of()));
  }

  private static Page.Raw raw(Object body, Map<String, String> headers) {
    return new Page.Raw(body, new HttpResponseSpec(200, "", headers));
  }

  @Test
  void walksEveryItemAcrossOffsetPages() {
    Recorder recorder =
        new Recorder(
            List.of(
                raw(List.of(Map.of("id", 1L), Map.of("id", 2L))),
                raw(List.of(Map.of("id", 3L))),
                raw(List.of())));
    PaginationScheme scheme =
        PaginationScheme.builder(PaginationScheme.Style.OFFSET)
            .limitParam("limit")
            .offsetParam("offset")
            .build();
    Paginator<Object> paginator = new Paginator<>(scheme, recorder, Map.of("limit", 2), null);

    assertEquals(3, paginator.all().size());
    // The offset advances by the number of items actually returned, not the requested limit: a
    // server
    // returning a short page must not cause items to be skipped.
    assertEquals(
        List.of(
            Map.of("limit", 2), Map.of("limit", 2, "offset", 2L), Map.of("limit", 2, "offset", 3L)),
        recorder.calls);
  }

  @Test
  void stopsOnAnEmptyPage() {
    Recorder recorder = new Recorder(List.of(raw(List.of()), raw(List.of(Map.of("id", 1L)))));
    Paginator<Object> paginator =
        new Paginator<>(
            PaginationScheme.builder(PaginationScheme.Style.OFFSET).build(),
            recorder,
            Map.of(),
            null);
    assertEquals(List.of(), paginator.all());
    assertEquals(1, recorder.calls.size());
  }

  @Test
  void followsACursorAndStopsWhenItIsAbsent() {
    Recorder recorder =
        new Recorder(
            List.of(
                raw(Map.of("items", List.of(Map.of("id", 1L)), "next", "c2")),
                raw(Map.of("items", List.of(Map.of("id", 2L))))));
    PaginationScheme scheme =
        PaginationScheme.builder(PaginationScheme.Style.CURSOR)
            .itemsPath("items")
            .cursorParam("cursor")
            .cursorPath("next")
            .build();
    Paginator<Object> paginator = new Paginator<>(scheme, recorder, Map.of(), null);
    assertEquals(2, paginator.all().size());
    assertEquals(Map.of("cursor", "c2"), recorder.calls.get(1));
  }

  @Test
  void stopsWhenAServerRepeatsACursor() {
    // A server echoing the same cursor is its bug, but the infinite loop would be ours.
    Recorder recorder =
        new Recorder(
            List.of(
                raw(Map.of("items", List.of(Map.of("id", 1L)), "next", "same")),
                raw(Map.of("items", List.of(Map.of("id", 2L)), "next", "same")),
                raw(Map.of("items", List.of(Map.of("id", 3L)), "next", "same"))));
    PaginationScheme scheme =
        PaginationScheme.builder(PaginationScheme.Style.CURSOR)
            .itemsPath("items")
            .cursorParam("cursor")
            .cursorPath("next")
            .build();
    assertEquals(2, new Paginator<>(scheme, recorder, Map.of(), null).all().size());
  }

  @Test
  void readsATotalFromAContentRangeHeader() {
    Recorder recorder =
        new Recorder(
            List.of(raw(List.of(Map.of("id", 1L)), Map.of("x-content-range", "items 0-0/227"))));
    PaginationScheme scheme =
        PaginationScheme.builder(PaginationScheme.Style.OFFSET)
            .totalHeader("X-Content-Range")
            .build();
    assertEquals(
        Integer.valueOf(227),
        new Paginator<>(scheme, recorder, Map.of(), null).firstPage().total());
  }

  @Test
  void readsABareIntegerTotalHeader() {
    Recorder recorder =
        new Recorder(List.of(raw(List.of(Map.of("id", 1L)), Map.of("x-total-count", "42"))));
    PaginationScheme scheme =
        PaginationScheme.builder(PaginationScheme.Style.OFFSET)
            .totalHeader("X-Total-Count")
            .build();
    assertEquals(
        Integer.valueOf(42), new Paginator<>(scheme, recorder, Map.of(), null).firstPage().total());
  }

  @Test
  void leavesTotalNullWhenTheHeaderIsAbsent() {
    Recorder recorder = new Recorder(List.of(raw(List.of(Map.of("id", 1L)))));
    PaginationScheme scheme =
        PaginationScheme.builder(PaginationScheme.Style.OFFSET)
            .totalHeader("X-Total-Count")
            .build();
    assertNull(new Paginator<>(scheme, recorder, Map.of(), null).firstPage().total());
  }

  @Test
  void firstPageIsMemoised() {
    Recorder recorder = new Recorder(List.of(raw(List.of(Map.of("id", 1L))), raw(List.of())));
    Paginator<Object> paginator =
        new Paginator<>(
            PaginationScheme.builder(PaginationScheme.Style.OFFSET).build(),
            recorder,
            Map.of(),
            null);
    paginator.firstPage();
    paginator.firstPage();
    assertEquals(1, recorder.calls.size());
  }

  @Test
  void isIterableAndStreamable() {
    // `for (var w : client.widgets().list())` is what a Java developer expects, and half of modern
    // Java
    // reaches for `stream()` first — so both work off the same walk.
    Recorder recorder = new Recorder(List.of(raw(List.of("a", "b")), raw(List.of())));
    Paginator<Object> paginator =
        new Paginator<>(
            PaginationScheme.builder(PaginationScheme.Style.OFFSET).build(),
            recorder,
            Map.of(),
            null);
    List<Object> seen = new ArrayList<>();
    for (Object item : paginator) {
      seen.add(item);
    }
    assertEquals(List.of("a", "b"), seen);

    Recorder second = new Recorder(List.of(raw(List.of("a", "b")), raw(List.of())));
    Paginator<Object> streamed =
        new Paginator<>(
            PaginationScheme.builder(PaginationScheme.Style.OFFSET).build(),
            second,
            Map.of(),
            null);
    assertEquals(2, streamed.stream().count());
  }

  @Test
  void appliesADecoderToEachItem() {
    Recorder recorder = new Recorder(List.of(raw(List.of(Map.of("id", "w_1"))), raw(List.of())));
    Paginator<String> paginator =
        new Paginator<>(
            PaginationScheme.builder(PaginationScheme.Style.OFFSET).build(),
            recorder,
            Map.of(),
            items ->
                items.stream().map(item -> String.valueOf(((Map<?, ?>) item).get("id"))).toList());
    assertEquals(List.of("w_1"), paginator.all());
  }

  @Test
  void toleratesNullValuesInTheInitialParameters() {
    // The bug this pins: `Map.copyOf` rejects null *values*, and an omitted optional query
    // parameter is
    // exactly a null — so every paginated call that left a parameter unset threw
    // NullPointerException. That is
    // the common case, not an edge one. Found by reading generated Java, not by any gate.
    Map<String, Object> params = new java.util.LinkedHashMap<>();
    params.put("limit", 2);
    params.put("offset", null);

    Recorder recorder = new Recorder(List.of(raw(List.of(Map.of("id", 1L))), raw(List.of())));
    Paginator<Object> paginator =
        new Paginator<>(
            PaginationScheme.builder(PaginationScheme.Style.OFFSET).offsetParam("offset").build(),
            recorder,
            params,
            null);
    assertEquals(1, paginator.all().size());
    // The null survives into the request, where `Query.flatten` drops it before the wire.
    assertTrue(recorder.calls.get(0).containsKey("offset"));
  }

  @Test
  void toleratesNullItemsInAPage() {
    // A JSON array may legitimately contain nulls; `List.copyOf` rejects them.
    Recorder recorder =
        new Recorder(List.of(raw(java.util.Arrays.asList("a", null)), raw(List.of())));
    Paginator<Object> paginator =
        new Paginator<>(
            PaginationScheme.builder(PaginationScheme.Style.OFFSET).build(),
            recorder,
            Map.of(),
            null);
    assertEquals(2, paginator.firstPage().items().size());
  }
}
