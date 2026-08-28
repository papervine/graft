package besdk.target.java;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Turns an IR into Java source files.
 *
 * <p>The shape of a generated package: one file per public type (Java requires it), a resource
 * class per resource holding a {@code Client}, a top-level client exposing them, a {@code Schemas}
 * class holding the validation descriptor table, and the vendored runtime under {@code
 * <package>.core}.
 */
public final class Emitter {

  /** One emitted file. */
  public record File(String path, String contents) {}

  private final Map<String, Object> ir;
  private final Map<String, Object> options;
  private final Map<String, Object> brand;
  private final TypeMapper types;
  private final Schemas schemas;
  private final Models models;
  private final String packageName;
  private final String clientClass;
  private final Map<String, Object> service;
  private final List<Map<String, Object>> warnings = new ArrayList<>();

  public Emitter(Map<String, Object> ir, Map<String, Object> options, Map<String, Object> brand) {
    this.ir = ir;
    this.options = options;
    this.brand = brand;
    this.types = new TypeMapper(ir);
    this.schemas = new Schemas(types);
    this.service = Ir.obj(ir.get("service"));
    String configured = Ir.str(options.get("packageName"), "");
    this.packageName =
        Ir.str(
            options.get("javaPackage"),
            configured.isEmpty() ? "com.acme.sdk" : Naming.packageName(configured));
    this.clientClass = deriveClientClass();
    this.models = new Models(types, packageName, generatedNotice());
  }

  /** Diagnostics travelling back in the manifest (SPEC.md §3.5). */
  public List<Map<String, Object>> warnings() {
    return List.copyOf(warnings);
  }

  public String packageName() {
    return packageName;
  }

  public String clientClass() {
    return clientClass;
  }

  /** Every file the SDK consists of. */
  public List<File> emit(Map<String, String> runtime) {
    List<File> files = new ArrayList<>(models.files());
    files.addAll(resourceFiles());
    files.add(clientFile());
    files.add(errorAliasFile());

    // After the resources, so every descriptor a method asked for is in the table.
    File schemaFile = schemaFile();
    if (schemaFile != null) {
      files.add(schemaFile);
    }

    // The runtime is vendored under `<package>.core`, so the generated package has no dependency on
    // the
    // generator. Java requires the package declaration to match the directory, so unlike Go and PHP
    // — where
    // the runtime's own package could simply be named `core` — the rewrite here is unavoidable.
    String corePackage = packageName + ".core";
    runtime.forEach(
        (name, contents) ->
            files.add(
                new File(
                    "src/main/java/" + corePackage.replace('.', '/') + "/" + name,
                    contents.replace("package besdk.runtime;", "package " + corePackage + ";"))));

    files.add(pomFile());
    files.add(readmeFile());
    // Per-operation examples and tests (SPEC.md §3.11), after the resources so a method the target
    // declined to generate is never referenced.
    files.addAll(new Examples(this, packageName).files());
    return files;
  }

  // -- resources ------------------------------------------------------------

  private List<File> resourceFiles() {
    List<File> out = new ArrayList<>();
    for (Map<String, Object> resource : flatResources()) {
      String name = resourceClass(resource);
      out.add(new File(models.sourcePath(name), resourceSource(resource, name)));
    }
    return out;
  }

  /**
   * Every resource, parents before children. Flattened because Java puts one public type per file.
   */
  private List<Map<String, Object>> flatResources() {
    List<Map<String, Object>> out = new ArrayList<>();
    collect(Ir.objects(ir.get("resources")), out);
    return out;
  }

  private void collect(List<Map<String, Object>> resources, List<Map<String, Object>> out) {
    for (Map<String, Object> resource : resources) {
      out.add(resource);
      collect(Ir.objects(resource.get("subresources")), out);
    }
  }

  private String resourceClass(Map<String, Object> resource) {
    return Naming.type(Ir.tokens(resource.get("name")));
  }

  private String resourceSource(Map<String, Object> resource, String className) {
    Source file = new Source(packageName, List.of());
    file.addImport(packageName + ".core.Client");
    file.addImport(packageName + ".core.RequestOptions");

    Map<String, Object> docs = Ir.obj(resource.get("docs"));
    String label = String.join(" ", Ir.tokens(resource.get("name")));
    List<String> doc = new ArrayList<>(List.of(generatedNotice(), ""));
    doc.addAll(
        Source.prose(
            Ir.str(docs.get("summary"), "The " + label + " resource."),
            Ir.str(docs.get("description"), null)));

    StringBuilder body = new StringBuilder(Source.javadoc(doc, 0));
    body.append("public final class ").append(className).append(" {\n\n");
    // The client is held rather than extended: a resource *is not* a client, and inheriting would
    // put every
    // transport method on the resource's public surface.
    body.append("  private final Client client;\n\n");
    body.append("  ")
        .append(className)
        .append("(Client client) {\n    this.client = client;\n  }\n");

    for (Map<String, Object> method : Ir.objects(resource.get("methods"))) {
      String rendered = Methods.render(this, resource, method, file);
      if (!rendered.isEmpty()) {
        body.append('\n').append(rendered);
      }
    }

    for (Map<String, Object> sub : Ir.objects(resource.get("subresources"))) {
      String subClass = resourceClass(sub);
      String accessor = Naming.member(Ir.tokens(sub.get("name")));
      body.append('\n')
          .append("  public ")
          .append(subClass)
          .append(' ')
          .append(accessor)
          .append("() {\n")
          .append("    return new ")
          .append(subClass)
          .append("(client);\n  }\n");
    }

    body.append("}");
    file.add(body.toString());
    return file.render();
  }

  // -- accessors the method emitter needs -----------------------------------

  TypeMapper types() {
    return types;
  }

  Schemas schemas() {
    return schemas;
  }

  /**
   * The models emitter, so the example renderer can read its component ordering rather than guess.
   */
  Models models() {
    return models;
  }

  Map<String, Object> irRoot() {
    return ir;
  }

  Models modelEmitter() {
    return models;
  }

  void warn(String message) {
    warnings.add(Map.of("severity", "warn", "code", "X001", "message", message));
  }

  // -- client ---------------------------------------------------------------

  private File clientFile() {
    Source file = new Source(packageName, List.of());
    file.addImport(packageName + ".core.Auth");
    file.addImport(packageName + ".core.Client");
    file.addImport(packageName + ".core.Transport");
    file.addImport(packageName + ".core.ValidationMode");
    file.addImport("java.time.Duration");
    file.addImport("java.util.Map");

    List<Map<String, Object>> auth = Ir.objects(service.get("auth"));
    boolean hasBearer = hasAuth(auth, "bearer");
    boolean hasBasic = hasAuth(auth, "basic");
    Map<String, Object> apiKey = findAuth(auth, "apiKey");
    Map<String, Object> bearer = findAuth(auth, "bearer");
    Map<String, Object> basic = findAuth(auth, "basic");
    Map<String, Object> oauth2 = findAuth(auth, "oauth2");
    boolean clientCredentials =
        oauth2 != null && "clientCredentials".equals(Ir.str(oauth2.get("flow"), ""));
    // Each credential paired with the environment variable it falls back to. The names come from
    // the
    // IR rather than being recomputed here, so every target reads the same variable for the same
    // credential — a client reading ACME_TOKEN in one language and ACMEPLATFORM_TOKEN in another is
    // a support ticket diagnosable from neither side. An empty string means no fallback.
    Map<String, String> envVars =
        Map.of(
            "token", bearer == null ? "" : Ir.str(bearer.get("envVar"), ""),
            "username", basic == null ? "" : Ir.str(basic.get("usernameEnvVar"), ""),
            "password", basic == null ? "" : Ir.str(basic.get("passwordEnvVar"), ""),
            "apiKey", apiKey == null ? "" : Ir.str(apiKey.get("envVar"), ""),
            "clientId", oauth2 == null ? "" : Ir.str(oauth2.get("clientIdEnvVar"), ""),
            "clientSecret", oauth2 == null ? "" : Ir.str(oauth2.get("clientSecretEnvVar"), ""),
            "refreshToken", oauth2 == null ? "" : Ir.str(oauth2.get("refreshTokenEnvVar"), ""));
    boolean readsEnv = envVars.values().stream().anyMatch(value -> !value.isEmpty());

    List<String> doc = new ArrayList<>(List.of(generatedNotice(), ""));
    doc.addAll(
        Source.prose(
            "The " + clientClass + " client.",
            "Construct one with " + clientClass + ".builder()."));

    StringBuilder body = new StringBuilder(Source.javadoc(doc, 0));
    body.append("public final class ").append(clientClass).append(" {\n\n");
    body.append("  private final Client client;\n");
    List<Map<String, Object>> resources = Ir.objects(ir.get("resources"));
    for (Map<String, Object> resource : resources) {
      body.append("  private final ")
          .append(resourceClass(resource))
          .append(' ')
          .append(Naming.member(Ir.tokens(resource.get("name"))))
          .append(";\n");
    }
    body.append('\n');

    body.append("  private ").append(clientClass).append("(Builder builder) {\n");
    if (hasBearer) {
      file.addImport(packageName + ".core.BearerAuth");
    }
    if (hasBasic) {
      file.addImport(packageName + ".core.BasicAuth");
    }
    if (apiKey != null) {
      file.addImport(packageName + ".core.ApiKeyAuth");
    }
    // Credentials resolved into locals first, so the expression below names each one once. Reading
    // the environment inside the expression meant `resolved(...)` was called twice per credential —
    // once in the condition and once in the value — which is two expressions for one credential and
    // only one of them stayed correct.
    for (String credential :
        List.of(
            "token",
            "username",
            "password",
            "apiKey",
            "clientId",
            "clientSecret",
            "refreshToken")) {
      if (!declaresCredential(credential, hasBearer, hasBasic, apiKey, oauth2, clientCredentials)) {
        continue;
      }
      String variable = envVars.get(credential);
      body.append("    String ").append(credential).append(" = ");
      if (variable.isEmpty()) {
        body.append("builder.").append(credential);
      } else {
        body.append("resolved(builder.")
            .append(credential)
            .append(", ")
            .append(Source.quote(variable))
            .append(")");
      }
      body.append(";\n");
    }
    if (oauth2 != null) {
      // The client file gains these only when the spec declares OAuth2, because `go`-style unused
      // imports
      // are a warning here and `-Werror` makes a warning fatal.
      file.addImport("java.util.List");
      file.addImport(packageName + ".core.OAuth2Auth");
      file.addImport(packageName + ".core.OAuth2Config");
      file.addImport(packageName + ".core.TokenSource");
      file.addImport(packageName + ".core.JdkTransport");
    }
    body.append(oauth2Prelude(oauth2, clientCredentials, packageName));
    body.append("    Auth auth = ")
        .append(authExpression(hasBearer, hasBasic, apiKey, oauth2))
        .append(";\n");
    body.append("    this.client =\n        Client.builder()\n");
    body.append("            .baseUrl(builder.baseUrl == null ? ")
        .append(Source.quote(defaultBaseUrl()))
        .append(" : builder.baseUrl)\n");
    body.append("            .auth(auth)\n");
    body.append("            .timeout(builder.timeout)\n");
    body.append("            .maxRetries(builder.maxRetries)\n");
    body.append("            .defaultHeaders(builder.defaultHeaders)\n");
    body.append("            .transport(builder.transport)\n");
    body.append("            .userAgent(").append(Source.quote(userAgent())).append(")\n");
    body.append("            .validation(builder.validation == null ? ValidationMode.")
        .append(validationConstant())
        .append(" : builder.validation)\n");
    String idempotency = Ir.str(options.get("idempotencyHeader"), null);
    if (idempotency != null) {
      body.append("            .idempotencyHeader(")
          .append(Source.quote(idempotency))
          .append(")\n");
    }
    body.append("            .build();\n");
    for (Map<String, Object> resource : resources) {
      body.append("    this.")
          .append(Naming.member(Ir.tokens(resource.get("name"))))
          .append(" = new ")
          .append(resourceClass(resource))
          .append("(this.client);\n");
    }
    body.append("  }\n\n");

    body.append("  public static Builder builder() {\n    return new Builder();\n  }\n");
    for (Map<String, Object> resource : resources) {
      String accessor = Naming.member(Ir.tokens(resource.get("name")));
      Map<String, Object> docs = Ir.obj(resource.get("docs"));
      body.append('\n');
      String summary = Ir.str(docs.get("summary"), null);
      if (summary != null) {
        body.append(Source.javadoc(Source.prose(summary, null), 2));
      }
      body.append("  public ")
          .append(resourceClass(resource))
          .append(' ')
          .append(accessor)
          .append("() {\n")
          .append("    return ")
          .append(accessor)
          .append(";\n  }\n");
    }

    body.append('\n')
        .append(
            Source.javadoc(
                List.of("The underlying transport, for a call this SDK does not cover yet."), 2))
        .append("  public Client core() {\n    return client;\n  }\n");

    if (readsEnv) {
      // Generated rather than in the runtime, because only generated code knows this API's
      // environment
      // variable — and reading it is what makes an unconfigured client work in a script.
      body.append('\n')
          .append(
              Source.javadoc(
                  List.of(
                      "An explicitly configured value, or the environment variable, or null.",
                      "",
                      "<p>Blank is treated as absent: an unset variable read through a shell often"
                          + " arrives as",
                      "the empty string, and an empty bearer token is never what anyone meant."),
                  2))
          .append(
              "  private static String resolved(String configured, String environmentVariable) {\n")
          .append(
              "    if (configured != null && !configured.isBlank()) {\n"
                  + "      return configured;\n"
                  + "    }\n")
          .append("    String value = System.getenv(environmentVariable);\n")
          .append("    return value == null || value.isBlank() ? null : value;\n  }\n");
    }
    body.append('\n');

    body.append(clientBuilder(hasBearer, hasBasic, apiKey, envVars, oauth2, clientCredentials));
    body.append("}");

    file.add(body.toString());
    return new File(models.sourcePath(clientClass), file.render());
  }

  private String clientBuilder(
      boolean hasBearer,
      boolean hasBasic,
      Map<String, Object> apiKey,
      Map<String, String> envVars,
      Map<String, Object> oauth2,
      boolean clientCredentials) {
    StringBuilder out =
        new StringBuilder(
            Source.javadoc(List.of("Fluent builder for {@link " + clientClass + "}."), 2));
    out.append("  public static final class Builder {\n\n");
    if (hasBearer) {
      out.append("    private String token;\n");
    }
    if (hasBasic) {
      out.append("    private String username;\n    private String password;\n");
    }
    if (apiKey != null) {
      out.append("    private String apiKey;\n");
    }
    if (oauth2 != null) {
      out.append("    private String clientId;\n    private String clientSecret;\n");
      if (!clientCredentials) {
        out.append("    private String refreshToken;\n");
      }
      out.append("    private List<String> scopes = List.of();\n");
    }
    out.append("    private String baseUrl;\n");
    out.append("    private Duration timeout = Duration.ofSeconds(60);\n");
    out.append("    private int maxRetries = 2;\n");
    out.append("    private Map<String, String> defaultHeaders = Map.of();\n");
    out.append("    private Transport transport;\n");
    out.append("    private ValidationMode validation;\n\n");
    out.append("    private Builder() {}\n");

    if (hasBearer) {
      out.append('\n')
          .append(
              Source.javadoc(
                  List.of(
                      envVars.get("token").isEmpty()
                          ? "Bearer token."
                          : "Bearer token. Read from " + envVars.get("token") + " when not set."),
                  4))
          .append(setter("token", "String"));
    }
    if (hasBasic) {
      out.append('\n')
          .append(Source.javadoc(List.of("Used with {@code password} for HTTP Basic."), 4))
          .append(setter("username", "String"));
      out.append('\n')
          .append(Source.javadoc(List.of("Used with {@code username} for HTTP Basic."), 4))
          .append(setter("password", "String"));
    }
    if (oauth2 != null) {
      String note =
          clientCredentials
              ? "OAuth2 client id. With {@code clientSecret}, this SDK obtains and refreshes"
                  + " tokens."
              : "OAuth2 client id, when the token endpoint requires one.";
      out.append('\n')
          .append(
              Source.javadoc(
                  List.of(
                      envVars.get("clientId").isEmpty()
                          ? note
                          : note + " Read from " + envVars.get("clientId") + " when not set."),
                  4))
          .append(setter("clientId", "String"));
      out.append('\n')
          .append(Source.javadoc(List.of("OAuth2 client secret. Used with {@code clientId}."), 4))
          .append(setter("clientSecret", "String"));
      if (!clientCredentials) {
        out.append('\n')
            .append(
                Source.javadoc(
                    List.of(
                        "A refresh token from your own authorization-code flow.",
                        "",
                        "<p>The redirect needs a browser, so it stays your application's job;"
                            + " keeping the",
                        "access token current does not."),
                    4))
            .append(setter("refreshToken", "String"));
      }
      out.append('\n')
          .append(
              Source.javadoc(
                  List.of("Scopes to request. Defaults to everything the spec declares."), 4))
          .append(setter("scopes", "List<String>"));
    }
    if (apiKey != null) {
      out.append('\n')
          .append(
              Source.javadoc(
                  List.of(
                      "Sent as the "
                          + Ir.str(apiKey.get("wireName"), "X-Api-Key")
                          + " "
                          + Ir.str(apiKey.get("location"), "header")
                          + "."),
                  4))
          .append(setter("apiKey", "String"));
    }
    out.append('\n')
        .append(Source.javadoc(List.of("Overrides the URL from the spec."), 4))
        .append(setter("baseUrl", "String"));
    out.append('\n')
        .append(Source.javadoc(List.of("Per-attempt timeout."), 4))
        .append(setter("timeout", "Duration"));
    out.append('\n')
        .append(Source.javadoc(List.of("Additional attempts for retryable failures."), 4))
        .append(setter("maxRetries", "int"));
    out.append('\n').append(setter("defaultHeaders", "Map<String, String>"));
    out.append('\n')
        .append(Source.javadoc(List.of("Inject one to test without real network calls."), 4))
        .append(setter("transport", "Transport"));
    out.append('\n')
        .append(Source.javadoc(List.of("How strictly responses are checked."), 4))
        .append(setter("validation", "ValidationMode"));

    out.append("\n    public ")
        .append(clientClass)
        .append(" build() {\n      return new ")
        .append(clientClass)
        .append("(this);\n    }\n  }\n");
    return out.toString();
  }

  private String setter(String name, String type) {
    return "    public Builder "
        + name
        + "("
        + type
        + " value) {\n      this."
        + name
        + " = value;\n      return this;\n    }\n";
  }

  /**
   * The auth expression, giving every declared scheme a branch.
   *
   * <p>Every scheme the spec declares gets one. An earlier version of the TypeScript target checked
   * only for a bearer token, so a spec declaring both OAuth2 and an API key generated a client that
   * silently ignored the key — it compiled, it looked right, and it could not authenticate (SPEC.md
   * §3.1.6).
   */
  /**
   * The token source, built before the auth expression so the expression stays one conditional.
   *
   * <p>A local rather than an inline construction, because the source needs the caller's transport
   * — a token fetched over a different one would bypass a test's injected transport and make a real
   * network call for authentication, which is the whole point of being able to inject it.
   */
  private String oauth2Prelude(
      Map<String, Object> oauth2, boolean clientCredentials, String packageName) {
    if (oauth2 == null) {
      return "";
    }
    List<String> scopeNames = new ArrayList<>();
    for (Map<String, Object> scope : Ir.objects(oauth2.get("scopes"))) {
      scopeNames.add(Source.quote(Ir.str(scope.get("name"), "")));
    }
    String defaultScopes =
        scopeNames.isEmpty()
            ? "builder.scopes"
            : "builder.scopes.isEmpty() ? List.of("
                + String.join(", ", scopeNames)
                + ") : builder.scopes";
    String ready =
        clientCredentials ? "clientId != null && clientSecret != null" : "refreshToken != null";

    StringBuilder out = new StringBuilder();
    out.append("    TokenSource tokenSource =\n        ")
        .append(ready)
        .append("\n            ? new TokenSource(\n")
        .append("                new OAuth2Config(\n")
        .append("                    ")
        .append(Source.quote(Ir.str(oauth2.get("tokenUrl"), "")))
        .append(
            ",\n"
                + "                    clientId,\n"
                + "                    clientSecret,\n"
                + "                    ")
        .append(clientCredentials ? "null" : "refreshToken")
        .append(",\n                    ")
        .append(defaultScopes)
        .append("),\n")
        // The caller's transport when they supplied one, or the JDK default the Client would use.
        .append(
            "                builder.transport != null ? builder.transport : new JdkTransport())\n")
        .append("            : null;\n");
    return out.toString();
  }

  private String authExpression(
      boolean hasBearer, boolean hasBasic, Map<String, Object> apiKey, Map<String, Object> oauth2) {
    List<String> rungs = new ArrayList<>();
    if (oauth2 != null) {
      // OAuth2 first: a spec declaring it alongside a static credential means "fetch a token, or
      // accept
      // one I already have", and the fetched one is the fresher of the two.
      rungs.add("tokenSource != null\n            ? new OAuth2Auth(tokenSource)");
    }
    if (hasBearer) {
      rungs.add("token != null\n            ? new BearerAuth(token)");
    }
    if (hasBasic) {
      rungs.add(
          "username != null && password != null\n"
              + "            ? new BasicAuth(username, password)");
    }
    if (apiKey != null) {
      rungs.add(
          "apiKey != null\n            ? new ApiKeyAuth(apiKey, "
              + Source.quote(Ir.str(apiKey.get("wireName"), "X-Api-Key"))
              + ", "
              + ("query".equals(Ir.str(apiKey.get("location"), "header")) ? "true" : "false")
              + ")");
    }
    if (rungs.isEmpty()) {
      return "Auth.NONE";
    }
    return String.join("\n            : ", rungs) + "\n            : Auth.NONE";
  }

  private boolean hasAuth(List<Map<String, Object>> auth, String kind) {
    return findAuth(auth, kind) != null;
  }

  private Map<String, Object> findAuth(List<Map<String, Object>> auth, String kind) {
    for (Map<String, Object> scheme : auth) {
      if (kind.equals(Ir.str(scheme.get("kind"), ""))) {
        return scheme;
      }
    }
    return null;
  }

  private String validationConstant() {
    return switch (Ir.str(options.get("validation"), "strict")) {
      case "warn" -> "WARN";
      case "off" -> "OFF";
      default -> "STRICT";
    };
  }

  /** Whether the spec declares the named credential at all. */
  private static boolean declaresCredential(
      String credential,
      boolean hasBearer,
      boolean hasBasic,
      Map<String, Object> apiKey,
      Map<String, Object> oauth2,
      boolean clientCredentials) {
    return switch (credential) {
      case "token" -> hasBearer;
      case "username", "password" -> hasBasic;
      case "apiKey" -> apiKey != null;
      // Both flows accept client credentials: the refresh flow needs them when the token endpoint
      // is
      // confidential, which plenty are.
      case "clientId", "clientSecret" -> oauth2 != null;
      case "refreshToken" -> oauth2 != null && !clientCredentials;
      default -> false;
    };
  }

  private String defaultBaseUrl() {
    Map<String, Object> chosen = null;
    for (Map<String, Object> server : Ir.objects(service.get("servers"))) {
      if (chosen == null || Ir.flag(server.get("default"))) {
        chosen = server;
      }
    }
    return chosen == null ? "" : Ir.str(chosen.get("url"), "");
  }

  private String userAgent() {
    return clientClass.toLowerCase(java.util.Locale.ROOT)
        + "/"
        + Ir.str(service.get("version"), "0.0.0")
        + " java";
  }

  private String deriveClientClass() {
    String configured = Ir.str(options.get("clientName"), null);
    if (configured != null) {
      return Naming.type(List.of(configured));
    }
    String display = Ir.str(service.get("displayName"), null);
    if (display != null) {
      String cleaned = display.replaceAll("[^A-Za-z0-9]", "");
      if (!cleaned.isEmpty()) {
        return Naming.type(List.of(cleaned));
      }
    }
    return Naming.type(Ir.tokens(service.get("name")));
  }

  String generatedNotice() {
    return Ir.str(brand.get("generatedNotice"), "Code generated. DO NOT EDIT.");
  }

  private String serviceLabel() {
    String display = Ir.str(service.get("displayName"), null);
    return display != null ? display : String.join(" ", Ir.tokens(service.get("name")));
  }

  // -- errors, schemas, package ---------------------------------------------

  /**
   * Aliases the runtime's error base under the consumer's own name.
   *
   * <p>The runtime's base is {@code SdkException}, named for its role. Generated code aliases it so
   * a {@code catch} reads in the user's terms — and so a rename of this project is not a breaking
   * change for every SDK it ever produced (SPEC.md §1.2).
   */
  private File errorAliasFile() {
    String alias = clientClass + "Exception";
    Source file = new Source(packageName, List.of());
    file.addImport(packageName + ".core.SdkException");
    StringBuilder body =
        new StringBuilder(
            Source.javadoc(
                List.of(
                    generatedNotice(),
                    "",
                    "Every error this SDK raises satisfies this type.",
                    "",
                    "<p>An abstract subclass rather than a type alias, which Java does not have —"
                        + " so",
                    "{@code catch (" + alias + " e)} works at compile time and at runtime."),
                0));
    body.append("public abstract class ").append(alias).append(" extends SdkException {\n\n");
    body.append("  private static final long serialVersionUID = 1L;\n\n");
    body.append("  protected ")
        .append(alias)
        .append("(String message) {\n    super(message);\n  }\n}");
    file.add(body.toString());
    return new File(models.sourcePath(alias), file.render());
  }

  private File schemaFile() {
    Map<String, String> table = schemas.table();
    if (table.isEmpty()) {
      return null;
    }
    Source file = new Source(packageName, List.of());
    file.addImport(packageName + ".core.Schema");
    file.addImport("java.util.Map");

    StringBuilder body =
        new StringBuilder(
            Source.javadoc(
                List.of(
                    generatedNotice(),
                    "",
                    "Runtime validation descriptors.",
                    "",
                    "<p>Data rather than generated checks: one hand-written walker in the runtime"
                        + " interprets",
                    "this, which is more trustworthy than a validator generated per type and a"
                        + " fraction of the",
                    "size. Only types reachable from a response are here — a spec's type graph is"
                        + " much larger",
                    "than its response graph, and a descriptor for a shape the client can never"
                        + " receive is",
                    "bytes every consumer ships for nothing.",
                    "",
                    "<p>Parsed once, at class initialisation. A per-call parse would be a"
                        + " per-request cost for",
                    "data that never changes."),
                0));
    body.append("final class Schemas {\n\n");
    body.append("  static final Map<String, Schema> TABLE = Schema.table(\n      ");
    List<String> entries = new ArrayList<>();
    table.forEach(
        (name, descriptor) -> entries.add(Source.quote("\"" + name + "\":" + descriptor)));
    // Concatenated string literals rather than one enormous line: javac caps a literal at 64KB, and
    // a large
    // spec's table exceeds that. The compiler folds the concatenation at compile time, so there is
    // no
    // runtime cost.
    body.append("\"{\"\n          + ")
        .append(String.join("\n          + \",\"\n          + ", entries));
    body.append("\n          + \"}\");\n\n");
    body.append("  private Schemas() {}\n}");
    file.add(body.toString());
    return new File(models.sourcePath("Schemas"), file.render());
  }

  private File pomFile() {
    String artifact = Ir.str(options.get("packageName"), "com.acme:sdk");
    String groupId =
        artifact.contains(":") ? artifact.substring(0, artifact.indexOf(':')) : "com.acme";
    String artifactId =
        artifact.contains(":") ? artifact.substring(artifact.indexOf(':') + 1) : artifact;
    String version = Ir.str(options.get("sdkVersion"), "0.1.0");

    String contents =
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <project xmlns="http://maven.apache.org/POM/4.0.0"
                 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                 xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
          <modelVersion>4.0.0</modelVersion>

          <groupId>%s</groupId>
          <artifactId>%s</artifactId>
          <version>%s</version>
          <packaging>jar</packaging>

          <description>Java SDK for %s.</description>

          <properties>
            <maven.compiler.release>21</maven.compiler.release>
            <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
          </properties>

          <!--
            No dependencies a consumer receives. The runtime is vendored under `%s.core`, and JSON is
            hand-written, so this SDK cannot conflict with whatever your application already depends on.

            JUnit is `test` scope, which Maven neither publishes in the artifact's metadata nor resolves
            transitively — so it exists for the generated per-operation tests and reaches nobody who
            depends on this package.
          -->
          <dependencies>
            <dependency>
              <groupId>org.junit.jupiter</groupId>
              <artifactId>junit-jupiter</artifactId>
              <version>5.11.3</version>
              <scope>test</scope>
            </dependency>
          </dependencies>

          <build>
            <plugins>
              <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <version>3.13.0</version>
                <configuration>
                  <compilerArgs>
                    <arg>-Xlint:all</arg>
                  </compilerArgs>
                </configuration>
              </plugin>
              <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-surefire-plugin</artifactId>
                <version>3.5.2</version>
              </plugin>
            </plugins>
          </build>
        </project>
        """
            .formatted(groupId, artifactId, version, serviceLabel(), packageName);
    return new File("pom.xml", contents);
  }

  private File readmeFile() {
    String artifact = Ir.str(options.get("packageName"), "com.acme:sdk");
    String groupId =
        artifact.contains(":") ? artifact.substring(0, artifact.indexOf(':')) : "com.acme";
    String artifactId =
        artifact.contains(":") ? artifact.substring(artifact.indexOf(':') + 1) : artifact;
    String version = Ir.str(options.get("sdkVersion"), "0.1.0");
    List<String> lines =
        new ArrayList<>(
            List.of(
                "# " + artifactId,
                "",
                "Java SDK for " + serviceLabel() + " v" + Ir.str(service.get("version"), "") + ".",
                "",
                "Requires **Java 21**. No dependencies: the runtime is vendored and JSON is"
                    + " hand-written, so",
                "this SDK cannot conflict with what your application already uses.",
                "",
                "## Install",
                "",
                "```xml",
                "<dependency>",
                "  <groupId>" + groupId + "</groupId>",
                "  <artifactId>" + artifactId + "</artifactId>",
                "  <version>" + version + "</version>",
                "</dependency>",
                "```",
                "",
                "## Quick start",
                "",
                "```java",
                "import " + packageName + "." + clientClass + ";",
                "",
                "var client = " + clientClass + ".builder().build();",
                "```",
                "",
                "## Errors",
                "",
                "Every error extends `"
                    + clientClass
                    + "Exception`, and all of them are **unchecked** — so a",
                "script can ignore them and a service can catch precisely:",
                "",
                "```java",
                "import " + packageName + ".core.NotFoundException;",
                "",
                "try {",
                "  // ...",
                "} catch (NotFoundException e) {",
                "  System.out.println(e.statusCode()); // 404",
                "}",
                "```",
                "",
                "---",
                "",
                Ir.str(brand.get("attribution"), "")));
    return new File("README.md", String.join("\n", lines) + "\n");
  }
}
