package graft.runtime;

import java.util.List;

/**
 * How a paginated operation advances.
 *
 * <p>Data rather than three subclasses: the differences between offset, page, and cursor paging are
 * entirely in which parameter changes and where the next value comes from.
 *
 * <p>A builder because eight of its nine fields are optional and which ones apply depends on the
 * style — a constructor would be nine positional nulls at most call sites.
 */
public final class PaginationScheme {

  /** Which parameter advances, and where the next value comes from. */
  public enum Style {
    OFFSET,
    PAGE,
    CURSOR
  }

  private final Style style;
  private final List<String> itemsPath;
  private final String limitParam;
  private final String offsetParam;
  private final String pageParam;
  private final String cursorParam;
  private final List<String> cursorPath;
  private final String totalHeader;
  private final List<String> totalPath;

  private PaginationScheme(Builder builder) {
    this.style = builder.style;
    this.itemsPath = builder.itemsPath;
    this.limitParam = builder.limitParam;
    this.offsetParam = builder.offsetParam;
    this.pageParam = builder.pageParam;
    this.cursorParam = builder.cursorParam;
    this.cursorPath = builder.cursorPath;
    this.totalHeader = builder.totalHeader;
    this.totalPath = builder.totalPath;
  }

  public static Builder builder(Style style) {
    return new Builder(style);
  }

  Style style() {
    return style;
  }

  /** Dotted path to the items, or null for a bare array response. */
  List<String> itemsPath() {
    return itemsPath;
  }

  String limitParam() {
    return limitParam;
  }

  String offsetParam() {
    return offsetParam;
  }

  String pageParam() {
    return pageParam;
  }

  String cursorParam() {
    return cursorParam;
  }

  List<String> cursorPath() {
    return cursorPath;
  }

  String totalHeader() {
    return totalHeader;
  }

  List<String> totalPath() {
    return totalPath;
  }

  /** Builder for a {@link PaginationScheme}. */
  public static final class Builder {

    private final Style style;
    private List<String> itemsPath;
    private String limitParam;
    private String offsetParam;
    private String pageParam;
    private String cursorParam;
    private List<String> cursorPath;
    private String totalHeader;
    private List<String> totalPath;

    private Builder(Style style) {
      this.style = style;
    }

    public Builder itemsPath(String... path) {
      this.itemsPath = List.of(path);
      return this;
    }

    public Builder limitParam(String value) {
      this.limitParam = value;
      return this;
    }

    public Builder offsetParam(String value) {
      this.offsetParam = value;
      return this;
    }

    public Builder pageParam(String value) {
      this.pageParam = value;
      return this;
    }

    public Builder cursorParam(String value) {
      this.cursorParam = value;
      return this;
    }

    public Builder cursorPath(String... path) {
      this.cursorPath = List.of(path);
      return this;
    }

    public Builder totalHeader(String value) {
      this.totalHeader = value;
      return this;
    }

    public Builder totalPath(String... path) {
      this.totalPath = List.of(path);
      return this;
    }

    public PaginationScheme build() {
      return new PaginationScheme(this);
    }
  }
}
