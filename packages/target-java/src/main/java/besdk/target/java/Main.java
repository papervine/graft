package besdk.target.java;

import besdk.runtime.Json;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * The target protocol entry point (SPEC.md §3.5).
 *
 * <pre>
 *   besdk-target-java --sdk-target-protocol   → handshake on stdout
 *   besdk-target-java                         → IR JSON on stdin, manifest on stdout
 * </pre>
 *
 * <p>Nothing here imports anything from besdk's core: the contract is the JSON, which is what makes
 * a target in <em>any</em> language possible. The one thing it does share with the runtime is the
 * JSON parser, which is a build dependency of the generator rather than a runtime dependency of
 * generated SDKs.
 */
public final class Main {

  private Main() {}

  public static void main(String[] args) {
    // `System.out` is the protocol channel, so every diagnostic goes to stderr. A stray println
    // would corrupt
    // the manifest in a way that reads as "the target produced invalid JSON".
    PrintStream out = System.out;
    PrintStream err = System.err;

    for (String arg : args) {
      if (Handshake.FLAG.equals(arg)) {
        out.println(Json.write(Handshake.describe()));
        return;
      }
    }

    String stdin;
    try (InputStream in = System.in) {
      stdin = new String(in.readAllBytes(), StandardCharsets.UTF_8);
    } catch (IOException error) {
      err.println("besdk-target-java: could not read stdin: " + error.getMessage());
      System.exit(2);
      return;
    }

    if (stdin.isBlank()) {
      err.println("besdk-target-java: expected IR JSON on stdin");
      System.exit(2);
      return;
    }

    Map<String, Object> payload;
    try {
      payload = Ir.obj(Json.parse(stdin));
    } catch (RuntimeException error) {
      err.println("besdk-target-java: stdin was not valid JSON: " + error.getMessage());
      System.exit(2);
      return;
    }

    Map<String, Object> ir = Ir.obj(payload.get("ir"));
    if (ir.isEmpty()) {
      err.println("besdk-target-java: payload had no `ir` object");
      System.exit(2);
      return;
    }

    Map<String, Object> brand = Ir.obj(payload.get("brand"));
    if (Ir.str(brand.get("generatedNotice"), null) == null) {
      // Required rather than defaulted: a hardcoded fallback would put this project's name in files
      // a consumer
      // commits, which is the one place it must never appear (SPEC.md §1.2).
      err.println("besdk-target-java: payload had no `brand.generatedNotice`");
      System.exit(2);
      return;
    }

    Emitter emitter = new Emitter(ir, Ir.obj(payload.get("options")), brand);
    List<Emitter.File> files;
    try {
      files = emitter.emit(loadRuntime());
    } catch (RuntimeException error) {
      err.println("besdk-target-java: " + error.getMessage());
      System.exit(70);
      return;
    }

    List<Object> manifest = new ArrayList<>();
    for (Emitter.File file : files) {
      Map<String, Object> entry = new LinkedHashMap<>();
      entry.put("path", file.path());
      entry.put("contents", file.contents());
      manifest.add(entry);
    }

    Map<String, Object> output = new LinkedHashMap<>();
    output.put("files", manifest);
    output.put("warnings", emitter.warnings());
    out.println(Json.write(output));
  }

  /**
   * The hand-written runtime's sources, for vendoring into the output.
   *
   * <p>Read from disk rather than inlined as string constants, so the runtime stays a normal
   * reviewable library that its own test suite exercises (SPEC.md §3.3).
   */
  private static Map<String, String> loadRuntime() {
    List<String> candidates = new ArrayList<>();
    String configured = System.getenv("SDK_JAVA_RUNTIME");
    if (configured != null) {
      candidates.add(configured);
    }
    candidates.add("packages/runtime-java/src/main/java/besdk/runtime");
    candidates.add("../runtime-java/src/main/java/besdk/runtime");

    for (String candidate : candidates) {
      Path dir = Path.of(candidate);
      if (!Files.isDirectory(dir)) {
        continue;
      }
      Map<String, String> files = new TreeMap<>();
      try (var stream = Files.list(dir)) {
        for (Path file : stream.toList()) {
          String name = file.getFileName().toString();
          if (name.endsWith(".java")) {
            files.put(name, Files.readString(file, StandardCharsets.UTF_8));
          }
        }
      } catch (IOException ignored) {
        continue;
      }
      if (!files.isEmpty()) {
        return files;
      }
    }

    throw new IllegalStateException(
        "no runtime sources found; set SDK_JAVA_RUNTIME to the runtime-java package directory");
  }
}
