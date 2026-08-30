package graft.target.java;

import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Turning IR token sequences into Java identifiers.
 *
 * <p>Names arrive as lowercase token sequences (`["user","id"]`) precisely so each target applies
 * its own convention (SPEC.md §3.2). Java's is `PascalCase` for types and `camelCase` for members —
 * and, unlike Go, initialisms are <em>not</em> wholly capitalised: the JDK itself writes {@code
 * getId}, {@code HttpClient}, and {@code URLEncoder} inconsistently, but modern convention and
 * google-java-format's own docs favour {@code getApiKey} over {@code getAPIKey}. This is the
 * clearest demonstration that token sequences were the right IR choice: the same name becomes
 * {@code UserID} in Go and {@code userId} here with no coordination.
 */
public final class Naming {

  /**
   * Java's reserved words, plus the literals.
   *
   * <p>A generated identifier colliding with one of these is a syntax error, not a style problem,
   * so the list is exhaustive for Java 21 rather than a best guess. {@code record}, {@code sealed},
   * {@code permits}, and {@code yield} are *contextual* keywords — legal as identifiers — so they
   * are deliberately absent.
   */
  private static final Set<String> RESERVED =
      Set.of(
          "abstract",
          "assert",
          "boolean",
          "break",
          "byte",
          "case",
          "catch",
          "char",
          "class",
          "const",
          "continue",
          "default",
          "do",
          "double",
          "else",
          "enum",
          "extends",
          "final",
          "finally",
          "float",
          "for",
          "goto",
          "if",
          "implements",
          "import",
          "instanceof",
          "int",
          "interface",
          "long",
          "native",
          "new",
          "package",
          "private",
          "protected",
          "public",
          "return",
          "short",
          "static",
          "strictfp",
          "super",
          "switch",
          "synchronized",
          "this",
          "throw",
          "throws",
          "transient",
          "try",
          "void",
          "volatile",
          "while",
          "true",
          "false",
          "null",
          "_");

  private Naming() {}

  /** A type name: {@code PascalCase}. */
  public static String type(List<String> tokens) {
    StringBuilder out = new StringBuilder();
    for (String token : tokens) {
      out.append(capitalise(token));
    }
    String name = out.toString();
    if (name.isEmpty()) {
      return "Value";
    }
    if (Character.isDigit(name.charAt(0))) {
      // `2FactorAuth` is not an identifier. Prefixed rather than stripped, because the digit is
      // usually
      // meaningful.
      return "N" + name;
    }
    // A type name can never be a reserved word, and unlike a member there is no context where it is
    // legal.
    return RESERVED.contains(name.toLowerCase(Locale.ROOT)) ? name + "Type" : name;
  }

  /** A member name: {@code camelCase}. */
  public static String member(List<String> tokens) {
    String pascal = type(tokens);
    String name = Character.toLowerCase(pascal.charAt(0)) + pascal.substring(1);
    if (Character.isDigit(name.charAt(0))) {
      return "n" + pascal;
    }
    // Unlike a type, a member genuinely cannot be a keyword — `int class` does not parse — so this
    // rename is
    // not optional.
    return RESERVED.contains(name) ? name + "Value" : name;
  }

  /**
   * A constant name: {@code SCREAMING_SNAKE_CASE}, which is what Java enum members use.
   *
   * <p>Separators in a wire value become underscores rather than being dropped: {@code us-east-1}
   * reads as {@code US_EAST_1}, which is what the AWS SDK and every hand-written Java enum does.
   */
  public static String constant(List<String> tokens) {
    StringBuilder out = new StringBuilder();
    for (String token : tokens) {
      String clean = token.replaceAll("[^A-Za-z0-9]+", "_");
      if (clean.isEmpty()) {
        continue;
      }
      if (out.length() > 0) {
        out.append('_');
      }
      out.append(clean.toUpperCase(Locale.ROOT));
    }
    String name = out.toString();
    if (name.isEmpty()) {
      return "VALUE";
    }
    return Character.isDigit(name.charAt(0)) ? "N" + name : name;
  }

  /**
   * A package name from a Maven-style group and artifact, or from a configured value.
   *
   * <p>{@code com.acme:acme-sdk} becomes {@code com.acme.acmesdk}. Hyphens are removed rather than
   * replaced with underscores, because a Java package segment must be a valid identifier and the
   * convention is all-lowercase with no separators.
   */
  public static String packageName(String value) {
    StringBuilder out = new StringBuilder();
    for (String segment : value.split("[.:/]")) {
      String clean = segment.replaceAll("[^A-Za-z0-9]+", "").toLowerCase(Locale.ROOT);
      if (clean.isEmpty()) {
        continue;
      }
      if (out.length() > 0) {
        out.append('.');
      }
      // A segment starting with a digit is not a legal identifier, and a package cannot be prefixed
      // the way a
      // class can without changing what the consumer types — so it is prefixed consistently.
      out.append(Character.isDigit(clean.charAt(0)) ? "n" + clean : clean);
    }
    return out.length() == 0 ? "sdk" : out.toString();
  }

  private static String capitalise(String token) {
    String clean = token.replaceAll("[^A-Za-z0-9]", "");
    if (clean.isEmpty()) {
      return "";
    }
    return Character.toUpperCase(clean.charAt(0)) + clean.substring(1);
  }
}
