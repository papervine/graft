package graft.target.java;

import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What this target tells the core about itself (SPEC.md §3.5).
 *
 * <p>The flag the core probes with carries no project name on purpose: a target hardcodes it
 * because it cannot import the constant that owns it, which makes it a promise to third-party
 * target authors rather than an internal detail (§1.2).
 */
public final class Handshake {

  public static final String FLAG = "--sdk-target-protocol";

  private Handshake() {}

  public static Map<String, Object> describe() {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("name", "java");
    out.put("displayName", "Java");
    out.put("version", "0.0.0");
    // Kept in step with `packages/protocol/src/branding.ts`. A mismatch is a hard error in the core
    // rather
    // than a warning, because a target reading an IR it does not understand produces a subtly wrong
    // SDK.
    out.put("irVersions", List.of("1.x"));
    // What this target actually emits — no more, and no less. `binary-responses` because a binary
    // or textual
    // body is returned as the raw string. Absent on purpose: `streaming`, because a streaming
    // method is
    // skipped with a warning rather than emitted as something that cannot work; `sync-and-async`,
    // because there is one blocking client.
    out.put(
        "capabilities",
        List.of("pagination", "binary-responses", "multipart-requests", "read-write-split"));
    out.put("lineComment", "//");
    out.put("gates", gates());
    return out;
  }

  /**
   * Verification gates for generated Java.
   *
   * <p>{@code javac -Xlint:all -Werror} because a warning in generated code is a defect a consumer
   * cannot fix by editing. google-java-format because it is the closest thing Java has to {@code
   * gofmt}: one canonical style with no configuration, which is exactly what makes a formatter a
   * gate rather than an argument.
   *
   * <p>Both resolve from this process's own environment and are declared with absolute paths, which
   * the protocol explicitly asks for — a target knows where its own tools are and the core does
   * not. A tool that cannot be found produces no gate at all rather than a gate that fails for the
   * wrong reason: `optional` cannot save a command invoked through an interpreter, which is the
   * lesson the PHP target paid for.
   */
  private static List<Map<String, Object>> gates() {
    List<Map<String, Object>> gates = new ArrayList<>();

    String formatter = onPath("google-java-format");
    if (formatter != null) {
      gates.add(
          Map.of(
              "name",
              "google-java-format",
              // `-i` rewrites in place. A formatter's exit code is not a verdict on the output,
              // which is what
              // `kind: fix` means.
              "command",
              List.of(
                  "sh", "-c", "find src -name '*.java' -print0 | xargs -0 " + formatter + " -i"),
              "kind",
              "fix",
              "optional",
              Boolean.TRUE));
    }

    String javac = javacPath();
    if (javac != null) {
      gates.add(
          Map.of(
              "name",
              "javac -Xlint:all -Werror",
              // Compiled to a scratch directory, so the gate leaves no class files in a package a
              // consumer
              // will commit.
              //
              // `src/main` only. `find src` swept in `src/test`, which imports JUnit — so the gate
              // failed
              // on every generated test with "package org.junit.jupiter.api does not exist", which
              // is the
              // gate being wrong rather than the output. The tests are compiled and run by `mvn
              // test`
              // below, where the dependency is resolvable.
              "command",
              List.of(
                  "sh",
                  "-c",
                  "find src/main -name '*.java' > .sdk-sources.txt && "
                      + javac
                      + " -d .sdk-classes --release 21 -Xlint:all -Werror @.sdk-sources.txt; "
                      + "status=$?; rm -rf .sdk-classes .sdk-sources.txt; exit $status"),
              // Never optional. Skipping the compiler removes the guarantee the whole pipeline is
              // premised on.
              "kind",
              "verify"));
    }

    String maven = mavenPath();
    if (maven != null) {
      gates.add(
          Map.of(
              "name",
              "generated tests",
              // `JAVA_HOME` is set to *this* JVM, which the launcher already chose for being 21 or
              // newer. Without it Maven used whatever its own environment pointed at and failed
              // with
              // "release version 21 not supported" — the generated pom targets 21, so the gate has
              // to
              // run on a JDK that can reach it. A target knows where its own tools are and the core
              // does not, which is what the protocol asks for.
              //
              // `-q` because a passing surefire run prints a page of plugin banners. Offline mode
              // is
              // deliberately not forced: JUnit has to be resolvable, and `-o` would fail rather
              // than
              // skip on a first run.
              "command",
              List.of(
                  "sh",
                  "-c",
                  "JAVA_HOME="
                      + System.getProperty("java.home")
                      + " "
                      + maven
                      + " -q --batch-mode test"),
              "kind",
              "verify",
              // Optional, unlike javac: Maven has to be installed and able to resolve JUnit, and a
              // first
              // generation on a machine with neither should not fail. Failing generation over an
              // absent
              // dev dependency would make the feature a liability (SPEC.md §3.11).
              "optional",
              true));
    }

    return gates;
  }

  /**
   * {@code javac} from this JVM's own home, which is the one that matches the version this target
   * needs.
   */
  /**
   * {@code mvn} on the PATH, or null.
   *
   * <p>Unlike {@code javac}, there is no JVM-relative location to fall back to — Maven is a
   * separate install, which is exactly why the gate that uses it is optional.
   */
  private static String mavenPath() {
    String path = System.getenv("PATH");
    if (path == null) {
      return null;
    }
    for (String dir : path.split(File.pathSeparator)) {
      File candidate = new File(dir, "mvn");
      if (candidate.canExecute()) {
        return candidate.getAbsolutePath();
      }
    }
    return null;
  }

  private static String javacPath() {
    String home = System.getProperty("java.home");
    if (home != null) {
      File candidate = new File(home, "bin/javac");
      if (candidate.canExecute()) {
        return candidate.getAbsolutePath();
      }
    }
    return onPath("javac");
  }

  private static String onPath(String name) {
    String path = System.getenv("PATH");
    if (path == null) {
      return null;
    }
    for (String dir : path.split(File.pathSeparator)) {
      File candidate = new File(dir, name);
      if (candidate.canExecute()) {
        return candidate.getAbsolutePath();
      }
    }
    return null;
  }
}
