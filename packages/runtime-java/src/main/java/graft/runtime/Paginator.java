package graft.runtime;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;

/**
 * Walks every page of a paginated operation.
 *
 * <p>{@code Iterable<T>} so {@code for (var widget : client.widgets().list())} works, which is what
 * a Java developer expects — the same reasoning that makes it an {@code AsyncIterable} in
 * TypeScript and an {@code IteratorAggregate} in PHP. {@link #stream()} exists because half of
 * modern Java reaches for it first, and {@link #firstPage()} for the case where one page is all the
 * caller wants.
 *
 * <p>Lazy: no request happens until iteration begins. That matters for the error path — a 404
 * surfaces where the caller iterates, not where they built the paginator.
 */
public final class Paginator<T> implements Iterable<T> {

  /** Fetches one page, given the parameters for it. */
  public interface Fetcher {
    Page.Raw fetch(Map<String, Object> params);
  }

  private final PaginationScheme scheme;
  private final Fetcher fetcher;
  private final Map<String, Object> initialParams;
  private final Function<List<Object>, List<T>> decoder;
  private Page<T> memoisedFirst;

  public Paginator(
      PaginationScheme scheme,
      Fetcher fetcher,
      Map<String, Object> initialParams,
      Function<List<Object>, List<T>> decoder) {
    this.scheme = scheme;
    this.fetcher = fetcher;
    // `Collections.unmodifiableMap` over a copy, not `Map.copyOf`: the latter rejects null
    // *values*, and an
    // omitted optional query parameter is exactly a null. `Map.copyOf` here meant every paginated
    // call that
    // left a parameter unset threw NullPointerException — the common case, not an edge one.
    // `Query.flatten`
    // drops the nulls before they reach the wire.
    this.initialParams =
        initialParams == null
            ? Map.of()
            : java.util.Collections.unmodifiableMap(new LinkedHashMap<>(initialParams));
    this.decoder = decoder;
  }

  @Override
  public Iterator<T> iterator() {
    Iterator<Page<T>> pages = pages().iterator();
    return new Iterator<>() {
      private Iterator<T> current = List.<T>of().iterator();

      @Override
      public boolean hasNext() {
        while (!current.hasNext()) {
          if (!pages.hasNext()) {
            return false;
          }
          current = pages.next().items().iterator();
        }
        return true;
      }

      @Override
      public T next() {
        if (!hasNext()) {
          throw new NoSuchElementException();
        }
        return current.next();
      }
    };
  }

  /** Every item, as a stream. */
  public Stream<T> stream() {
    return StreamSupport.stream(spliterator(), false);
  }

  /** Every item, materialised. */
  public List<T> all() {
    List<T> out = new ArrayList<>();
    for (T item : this) {
      out.add(item);
    }
    return out;
  }

  /**
   * The first page, without walking the rest.
   *
   * <p>Memoised, so calling it twice does not re-request.
   */
  public Page<T> firstPage() {
    if (memoisedFirst == null) {
      Iterator<Page<T>> pages = pages().iterator();
      memoisedFirst = pages.hasNext() ? pages.next() : new Page<>(List.of(), null, false);
    }
    return memoisedFirst;
  }

  /** Page by page, rather than item by item. */
  public Iterable<Page<T>> pages() {
    return () ->
        new Iterator<>() {
          private Map<String, Object> params = new LinkedHashMap<>(initialParams);
          private final Set<String> seenCursors = new HashSet<>();
          private boolean done;
          private Page<T> pending;

          @Override
          public boolean hasNext() {
            // `pending` is checked *before* `done`, and the order is the whole bug this had: an
            // empty final
            // page sets `done` and stashes itself as pending, so a `done`-first check made `next()`
            // throw
            // `NoSuchElementException` on the page `hasNext()` had just promised. A fetched page is
            // always
            // deliverable, whether or not the walk is over.
            if (pending != null) {
              return true;
            }
            if (done) {
              return false;
            }
            Page.Raw raw =
                fetcher.fetch(java.util.Collections.unmodifiableMap(new LinkedHashMap<>(params)));
            pending = pageFrom(raw);

            // An empty page ends the walk regardless of what the scheme says. A server that keeps
            // answering
            // with `[]` and a next cursor would otherwise loop forever.
            if (pending.items().isEmpty()) {
              done = true;
              return true;
            }
            advance(raw);
            return true;
          }

          @Override
          public Page<T> next() {
            if (!hasNext()) {
              throw new NoSuchElementException();
            }
            Page<T> result = pending;
            pending = null;
            return result;
          }

          private void advance(Page.Raw raw) {
            switch (scheme.style()) {
              case CURSOR -> {
                Object cursor = pathValue(raw.body(), scheme.cursorPath());
                if (!(cursor instanceof String next) || next.isEmpty()) {
                  done = true;
                  return;
                }
                // A server echoing the same cursor is its bug, but the infinite loop would be ours.
                if (!seenCursors.add(next)) {
                  done = true;
                  return;
                }
                params.put(scheme.cursorParam() == null ? "cursor" : scheme.cursorParam(), next);
              }
              case PAGE -> {
                String key = scheme.pageParam() == null ? "page" : scheme.pageParam();
                Object current = params.get(key);
                long value = current instanceof Number n ? n.longValue() : 1;
                params.put(key, value + 1);
              }
              case OFFSET -> {
                String key = scheme.offsetParam() == null ? "offset" : scheme.offsetParam();
                Object current = params.get(key);
                long value = current instanceof Number n ? n.longValue() : 0;
                // Advances by the number of items actually returned, not by the requested limit: a
                // server
                // returning a short page must not cause items to be skipped.
                params.put(key, value + pending.items().size());
              }
            }
          }
        };
  }

  private Page<T> pageFrom(Page.Raw raw) {
    Object source =
        scheme.itemsPath() == null ? raw.body() : pathValue(raw.body(), scheme.itemsPath());
    // `new ArrayList<>`, not `List.copyOf`: a JSON array may contain nulls and `List.copyOf`
    // rejects them.
    // Third place in this class where that mattered, which is why the rule is stated once here and
    // the
    // reasoning is not repeated at each site.
    List<Object> items = source instanceof List<?> list ? new ArrayList<>(list) : List.of();
    List<T> decoded = decoder == null ? castRaw(items) : decoder.apply(items);

    Integer total = null;
    if (scheme.totalHeader() != null) {
      String header = raw.response().header(scheme.totalHeader());
      if (header != null) {
        // `X-Content-Range: items 0-49/227` — the total is after the slash, and a bare integer is
        // also in
        // use. Both are read rather than one being declared correct.
        int slash = header.lastIndexOf('/');
        String candidate = slash >= 0 ? header.substring(slash + 1) : header;
        try {
          total = Integer.valueOf(candidate.trim());
        } catch (NumberFormatException ignored) {
          total = null;
        }
      }
    } else if (scheme.totalPath() != null) {
      Object value = pathValue(raw.body(), scheme.totalPath());
      total = value instanceof Number n ? Integer.valueOf(n.intValue()) : null;
    }

    boolean hasNext =
        scheme.style() == PaginationScheme.Style.CURSOR
            ? pathValue(raw.body(), scheme.cursorPath()) instanceof String
            : !items.isEmpty();

    return new Page<>(decoded, total, hasNext);
  }

  /**
   * Items with no decoder are handed back as-is.
   *
   * <p>Unchecked, and unavoidable: a paginated response of scalars has nothing to decode, so {@code
   * T} is whatever the JSON contained. The generated method's declared type is the one that has
   * been checked, by the validator, before this runs.
   */
  @SuppressWarnings("unchecked")
  private List<T> castRaw(List<Object> items) {
    return (List<T>) items;
  }

  private static Object pathValue(Object body, List<String> path) {
    if (path == null) {
      return null;
    }
    Object node = body;
    for (String segment : path) {
      if (!(node instanceof Map<?, ?> map) || !map.containsKey(segment)) {
        return null;
      }
      node = map.get(segment);
    }
    return node;
  }
}
