package besdk.target.java;

import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

/**
 * A Java source file under construction.
 *
 * <p>Not a parser-based AST, which is the third target to reach the same conclusion (SPEC.md §3.3.4
 * states it as a rule): emit through a language's AST only when its AST library is designed for
 * <em>synthesis</em>. Java has no such library in the JDK, and the third-party ones are analysis
 * tools.
 *
 * <p>What this does earn over string concatenation is import management — deduplicated and sorted
 * at render time, so callers add freely without tracking what they already added — and a single
 * place that knows the file's shape. Layout beyond that is google-java-format's job, and because
 * that formatter has one canonical style with no configuration, its output is byte-identical to
 * what a Java developer's IDE produces.
 */
public final class Source {

  private final String packageName;
  private final List<String> fileDoc;
  private final TreeSet<String> imports = new TreeSet<>();
  private final List<String> declarations = new ArrayList<>();

  public Source(String packageName, List<String> fileDoc) {
    this.packageName = packageName;
    this.fileDoc = List.copyOf(fileDoc);
  }

  /** Register an import. Anything in {@code java.lang} or this file's own package is dropped. */
  public void addImport(String fqn) {
    if (fqn == null || fqn.isEmpty() || fqn.startsWith("java.lang.")) {
      return;
    }
    // A class in this file's own package needs no import, and javac warns about one.
    String enclosing = fqn.contains(".") ? fqn.substring(0, fqn.lastIndexOf('.')) : "";
    if (enclosing.equals(packageName)) {
      return;
    }
    imports.add(fqn);
  }

  public void addImports(List<String> fqns) {
    fqns.forEach(this::addImport);
  }

  public void add(String declaration) {
    declarations.add(declaration.stripTrailing());
  }

  public String render() {
    StringBuilder out = new StringBuilder();
    out.append("package ").append(packageName).append(";\n");
    if (!imports.isEmpty()) {
      out.append('\n');
      for (String each : imports) {
        out.append("import ").append(each).append(";\n");
      }
    }
    if (!fileDoc.isEmpty()) {
      out.append('\n').append(javadoc(fileDoc, 0));
    }
    for (String declaration : declarations) {
      out.append('\n').append(declaration).append('\n');
    }
    return out.toString();
  }

  /** Render lines as a javadoc block at the given indentation. */
  public static String javadoc(List<String> lines, int indent) {
    if (lines.isEmpty()) {
      return "";
    }
    String pad = " ".repeat(indent);
    StringBuilder out = new StringBuilder(pad).append("/**\n");
    for (String line : lines) {
      out.append(line.isEmpty() ? pad + " *\n" : pad + " * " + line + "\n");
    }
    return out.append(pad).append(" */\n").toString();
  }

  /**
   * Collapse prose from a spec into javadoc lines.
   *
   * <p>Specs are careless with whitespace, so text is normalised rather than passed through. {@code
   * *&#47;} is escaped because a description containing it would close the comment early and
   * produce a syntax error — not hypothetical: it happens in specs that document glob patterns.
   * HTML-significant characters are escaped too, because javadoc is HTML and an unescaped {@code <}
   * makes {@code javadoc} fail.
   */
  public static List<String> prose(String summary, String description) {
    List<String> lines = new ArrayList<>();
    List<String> parts = new ArrayList<>();
    if (summary != null && !summary.isBlank()) {
      parts.add(summary.trim());
    }
    if (description != null && !description.isBlank() && !description.trim().equals(summary)) {
      parts.add(description.trim());
    }
    boolean first = true;
    for (String part : parts) {
      if (!first) {
        lines.add("");
        // A javadoc paragraph break needs the tag, or the formatter inserts it and the output
        // drifts.
        lines.add("<p>" + wrapped(part).get(0));
        lines.addAll(wrapped(part).subList(1, wrapped(part).size()));
        continue;
      }
      first = false;
      lines.addAll(wrapped(part));
    }
    return lines;
  }

  private static List<String> wrapped(String text) {
    String clean =
        text.replace("*/", "*&#47;")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replaceAll("\\s+", " ")
            .trim();
    List<String> out = new ArrayList<>();
    StringBuilder line = new StringBuilder();
    for (String word : clean.split(" ")) {
      if (line.length() > 0 && line.length() + word.length() + 1 > 96) {
        out.add(line.toString());
        line = new StringBuilder();
      }
      if (line.length() > 0) {
        line.append(' ');
      }
      line.append(word);
    }
    if (line.length() > 0) {
      out.add(line.toString());
    }
    return out.isEmpty() ? List.of(clean) : out;
  }

  /** A Java string literal, escaped. */
  public static String quote(String value) {
    StringBuilder out = new StringBuilder("\"");
    for (char c : value.toCharArray()) {
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> out.append(c);
      }
    }
    return out.append('"').toString();
  }
}
