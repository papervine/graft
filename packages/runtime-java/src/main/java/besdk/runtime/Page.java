package besdk.runtime;

import java.util.List;

/**
 * One page of results.
 *
 * @param total the server's reported total, or null when it did not report one
 * @param hasNextPage whether another page exists
 */
public record Page<T>(List<T> items, Integer total, boolean hasNextPage) {

  public Page {
    // `unmodifiableList` over a copy, not `List.copyOf`: a JSON array may legitimately contain
    // nulls, and
    // `List.copyOf` rejects them.
    items =
        items == null
            ? List.of()
            : java.util.Collections.unmodifiableList(new java.util.ArrayList<>(items));
  }

  /**
   * A page before decoding: the raw body plus the response it came in.
   *
   * <p>Both are needed — items come from the body, and a total may arrive in a header.
   */
  public record Raw(Object body, HttpResponseSpec response) {}
}
