"""The Python emitter: IR in, file manifest out.

The shape produced here is modelled on the Python SDKs people actually enjoy — OpenAI's and
Anthropic's:

    client = Acme(token=os.environ["ACME_TOKEN"])
    widget = client.widgets.create(name="Sprocket")
    for widget in client.widgets.list(limit=50):
        print(widget.id)

    async with AsyncAcme() as client:
        widget = await client.widgets.create(name="Sprocket")

Two structural decisions, both recorded in SPEC.md §3.3.2:

- **Read models are pydantic, write models are TypedDict.** A response is received, so attribute
  access and validation are what you want; a request body is constructed, so a dict literal is.
  The IR's `role` says which, so the target never has to infer it.
- **Sync and async are both generated.** Python has no `await`-works-on-both, and half an SDK is
  the commonest complaint about generated Python clients.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from .builder import Assignment, Attribute, Class, Function, Module, Param, literal_union
from .naming import (
    ANNOTATION_BUILTINS,
    RUNTIME_EXPORTS,
    module_name,
    pascal,
    safe_attribute,
    safe_identifier,
    safe_method_name,
    snake,
    unique_attribute,
)
from .types import TypeMapper

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

GeneratedFile = dict[str, str]

# Statuses the runtime already defines a class for; a spec that declares one of these needs nothing
# generated, and generating it anyway would shadow the runtime import.
_RUNTIME_ERROR_STATUSES = frozenset({400, 401, 403, 404, 409, 422, 429})


class _LocalNames:
    """Names for a generated method body's temporaries, guaranteed not to shadow a parameter.

    Every name is derived by appending underscores until it is free, which keeps the common case
    (`query`, `data`) completely ordinary, and only makes it odd where the spec forced
    it — which is the right trade, because the alternative is silently wrong code.
    """

    __slots__ = ("data", "fetch", "headers", "items", "params", "query")

    def __init__(self, taken: set[str]) -> None:
        claimed = set(taken)

        def pick(preferred: str) -> str:
            candidate = preferred
            while candidate in claimed:
                candidate = f"{candidate}_"
            claimed.add(candidate)
            return candidate

        self.query = pick("query")
        self.headers = pick("headers")
        self.data = pick("data")
        self.items = pick("items")
        self.params = pick("params")
        self.fetch = pick("_fetch")


def _readme_env_var(auth_schemes: Sequence[Mapping[str, Any]]) -> str | None:
    """The environment variable the README's example relies on, or None when there is no auth.

    Ordered by which credential the generated example actually constructs with: a bearer token
    first, then an API key, then Basic's username. `None` means the sentence is omitted rather
    than naming a variable nothing reads.
    """
    for scheme in auth_schemes:
        if scheme["kind"] == "bearer" and scheme.get("envVar"):
            return str(scheme["envVar"])
    for scheme in auth_schemes:
        if scheme["kind"] == "apiKey" and scheme.get("envVar"):
            return str(scheme["envVar"])
    for scheme in auth_schemes:
        if scheme["kind"] == "basic" and scheme.get("usernameEnvVar"):
            return str(scheme["usernameEnvVar"])
    for scheme in auth_schemes:
        if scheme["kind"] == "oauth2" and scheme.get("clientIdEnvVar"):
            return str(scheme["clientIdEnvVar"])
    return None


def _auth_rungs(
    has_bearer: bool,
    has_basic: bool,
    api_key: Mapping[str, Any] | None,
    *,
    first: bool,
) -> list[str]:
    """The non-OAuth2 credential branches, as one `if`/`elif` chain.

    One builder driven by what the spec declares, rather than a hand-written branch per combination.
    The combination version handled bearer, bearer+basic, basic, and api-key separately, and the
    TypeScript target's equivalent silently emitted "no auth" for the one combination nobody had
    enumerated — a client that compiles and cannot authenticate. A builder cannot omit a case.

    `first` distinguishes a chain that stands alone from one continuing an OAuth2 `if`.
    """
    rungs: list[str] = []

    def rung(condition: str, *value: str) -> None:
        keyword = "if" if not rungs and first else "elif"
        rungs.append(f"{keyword} {condition}:")
        rungs.extend(f"    {line}" for line in value)

    if has_bearer:
        rung("token is not None", 'auth = Auth("bearer", token=token)')
    if has_basic:
        rung(
            "username is not None and password is not None",
            'auth = Auth("basic", username=username, password=password)',
        )
    if api_key is not None:
        rung(
            "api_key is not None",
            "auth = Auth(",
            f'    "api_key", token=api_key, wire_name={api_key["wireName"]!r},',
            f"    location={api_key.get('location', 'header')!r})",
        )
    if not rungs:
        return ['auth = Auth("none")']
    rungs.append("else:")
    rungs.append('    auth = Auth("none")')
    return rungs


def _default_base_url(server: Mapping[str, Any] | None) -> str:
    """The default base URL, as a Python expression.

    A plain literal unless the server was templated, in which case it is an f-string reading each
    variable off the constructor arguments and falling back to the spec's default. Written inline
    rather than through a runtime helper because the result says exactly what it does:
    `f"https://{region or 'us-east-1'}.api.example.com"`.

    Substituted into `urlTemplate` rather than assembled from parts, so a URL where a
    variable appears twice, or inside a path segment, comes out right with no special
    cases.
    """
    if server is None:
        return repr("")
    variables = list(server.get("variables") or [])
    template = server.get("urlTemplate")
    if not variables or not isinstance(template, str):
        return repr(server.get("url", ""))
    # Braces already in the URL would be read as f-string placeholders. Neither is legal in a URL,
    # but a malformed spec is not a reason to emit code that does not parse.
    rendered = template.replace("{", "\0OPEN").replace("}", "\0CLOSE")
    for variable in variables:
        attribute = safe_attribute(snake(variable["name"]["tokens"]))
        rendered = rendered.replace(
            f"\0OPEN{variable['wireName']}\0CLOSE",
            "{" + f"{attribute} or {variable['default']!r}" + "}",
        )
    rendered = rendered.replace("\0OPEN", "{{").replace("\0CLOSE", "}}")
    return "f" + repr(rendered)


def _qualify_builtins(annotation: str | None, shadowed: set[str]) -> str | None:
    """Rewrite `list[X]` to `builtins.list[X]` for builtins shadowed in the enclosing class.

    A word-boundary substitution rather than a parse: annotations here are rendered strings, and the
    names in question (`list`, `dict`, `str`, ...) are only ever whole tokens in them. The guard is
    that only names in `shadowed` are touched, so a class that shadows nothing is left alone.
    """
    if annotation is None or not shadowed:
        return annotation
    pattern = r"\b(" + "|".join(sorted(shadowed)) + r")\b"
    return re.sub(pattern, lambda m: f"builtins.{m.group(1)}", annotation)


def _docs(docs: Mapping[str, Any] | None, extra: Sequence[str] = ()) -> str | None:
    """Assemble a docstring from the IR's summary and description."""
    if docs is None:
        docs = {}
    lines: list[str] = []
    summary = (docs.get("summary") or "").strip()
    description = (docs.get("description") or "").strip()
    if summary:
        lines.append(summary)
    if description and description != summary:
        if lines:
            lines.append("")
        lines.append(description)
    if extra:
        if lines:
            lines.append("")
        lines.extend(extra)
    return "\n".join(lines) if lines else None


# Names re-exported from the vendored runtime by the generated package's `__init__`.
#
# **One list, used for both the import statement and `__all__`.** They used to be two, and adding a
# name to only one of them produced an unused import that failed the generated package's own lint.
# Duplicated lists of the same thing drift; this codebase has learned that three times.
_RUNTIME_REEXPORTS = (
    "APIConnectionError",
    "APIConnectionTimeoutError",
    "APIError",
    "APIStatusError",
    "AuthenticationError",
    "BadRequestError",
    "ConflictError",
    "InternalServerError",
    "NOT_GIVEN",
    "NotFoundError",
    "NotGiven",
    # OAuth2. `OAuth2Error` is not an APIError, so a caller needs to name it to catch it.
    "OAuth2Config",
    "OAuth2Error",
    "Page",
    "PermissionDeniedError",
    "RateLimitError",
    "RequestOptions",
    "SDKError",
    "UnprocessableEntityError",
)


class PythonEmitter:
    def __init__(
        self,
        ir: Mapping[str, Any],
        options: Mapping[str, Any],
        brand: Mapping[str, Any],
    ) -> None:
        self.ir = ir
        self.options = options
        # This project's own name, from the protocol rather than written here as a constant.
        # Generated files are files consumers commit, so a project rename must not break them — and
        # this target cannot import the TypeScript module that owns the name. There is deliberately
        # no fallback: a hardcoded default is the thing the rule forbids.
        self.brand = brand
        self.types = TypeMapper(ir)
        self.package = self._package_name()
        self.client_name = self._client_name()
        # Diagnostics travelling back with the manifest. The target had no channel for these at all
        # and always reported `warnings: []`, so anything it declined to generate was invisible —
        # which is how a multipart operation came to be emitted as a JSON request and shipped.
        self.warnings: list[dict[str, str]] = []
        # Wire name to Python attribute, per type id, recorded by the models emitter.
        #
        # Read rather than recomputed, because `unique_attribute` disambiguates by *order*
        # — two wire names can sanitise to one identifier, and which gets the suffix depends
        # on which was seen first. Recomputing it in the example renderer produced `id_=`
        # where the model declared `id`: an example that did not typecheck.
        self._attributes: dict[str, dict[str, str]] = {}
        # Model classes referenced by the example currently being rendered, so it can import them.
        # An example constructing `MemberInvitedEvent(...)` without importing it is an `F821` and a
        # file that does not run — caught by the generated package's own ruff gate.
        self._example_imports: set[str] = set()

    def warn(self, code: str, message: str) -> None:
        """Record a diagnostic to return alongside the manifest."""
        self.warnings.append({"code": code, "severity": "warn", "message": message})

    # -- naming -----------------------------------------------------------

    def _package_name(self) -> str:
        configured = self.options.get("packageName")
        if isinstance(configured, str) and configured:
            # A PyPI distribution name may contain hyphens; the importable module may not.
            return safe_identifier(configured.replace("-", "_"))
        return safe_identifier(snake(self.ir["service"]["name"]["tokens"]))

    def _client_name(self) -> str:
        """The client class name.

        Same policy as the TypeScript target, for the same reasons: no `Client` suffix, because
        `Acme()` already says "construct a client"; and the author's own casing from `displayName`
        is preferred so `IBMCloud` does not become `IbmCloud`.
        """
        configured = self.options.get("clientName")
        if isinstance(configured, str) and configured:
            return configured
        display = self.ir["service"].get("displayName")
        if isinstance(display, str):
            candidate = "".join(part for part in display.split() if part)
            if candidate[:1].isupper() and candidate.isidentifier():
                return candidate
        return pascal(self.ir["service"]["name"]["tokens"])

    # -- traversal --------------------------------------------------------

    @property
    def all_resources(self) -> list[Mapping[str, Any]]:
        flat: list[Mapping[str, Any]] = []

        def walk(resources: Sequence[Mapping[str, Any]]) -> None:
            for resource in resources:
                flat.append(resource)
                walk(resource.get("subresources", []))

        walk(self.ir.get("resources", []))
        return flat

    def resource_class(self, resource: Mapping[str, Any], *, is_async: bool) -> str:
        base = pascal(resource["name"]["tokens"])
        declared = {self.types.declared_name(t["id"]) for t in self.ir.get("types", [])}
        if base in declared:
            base = f"{base}Resource"
        return f"Async{base}" if is_async else base

    # -- models -----------------------------------------------------------

    def _model_class(self, named: Mapping[str, Any], module: Module) -> Class | Assignment:
        """One IR named type as a Python class.

        The read/write split lands directly on a distinction Python already makes, which is the
        clearest evidence so far that the split was modelled at the right level.
        """
        name = self.types.declared_name(named["id"])
        kind = named["kind"]

        if kind == "enum":
            module.import_from("typing", "Literal")
            values = [member.get("wireValue") for member in named.get("members", [])]
            alias = Assignment(
                name=name,
                value=literal_union(values, open_ended=bool(named.get("open"))),
                annotation="TypeAlias",
                docstring=_docs(
                    named.get("docs"),
                    ["The server may add values; an unknown value is preserved, not rejected."]
                    if named.get("open")
                    else (),
                ),
            )
            module.import_from("typing", "TypeAlias")
            return alias

        if kind == "alias":
            module.import_from("typing", "TypeAlias")
            return Assignment(
                name=name,
                value=self.types.render(named.get("target")),
                annotation="TypeAlias",
                docstring=_docs(named.get("docs")),
            )

        role = named.get("role", "shared")
        is_write = role in ("create", "update")

        if is_write:
            # `typing_extensions`, not `typing`: `NotRequired` only reached `typing` in 3.11, and
            # the
            # generated package declares `requires-python = ">=3.10"`. pydantic already depends on
            # `typing_extensions`, so this adds nothing to a consumer's dependency tree.
            #
            # `TypedDict` comes from the same place deliberately — pydantic will not validate a
            # `typing.TypedDict` on some versions, and mixing the two sources is the kind of subtle
            # split that only shows up on one interpreter.
            module.import_from("typing_extensions", "NotRequired", "TypedDict")
            base = "TypedDict"
        else:
            module.import_from("pydantic", "BaseModel")
            base = "BaseModel"

        attributes: list[Attribute] = []
        used_names: set[str] = set()
        for field in named.get("fields", []):
            annotation = self.types.render(field["type"])
            required = bool(field.get("required"))
            wire = field["wireName"]
            attribute_name = unique_attribute(snake(field["name"]["tokens"]), used_names)
            self._attributes.setdefault(str(named.get("id")), {})[str(wire)] = attribute_name

            notes: list[str] = []
            if field.get("deprecated"):
                notes.append("Deprecated.")
            if field.get("serverOwned"):
                notes.append("Assigned by the server.")

            if is_write:
                # `NotRequired` for absence; `| None` already came from the type if it is nullable.
                # Keeping them separate is the whole point of §3.1.
                attributes.append(
                    Attribute(
                        name=attribute_name,
                        annotation=annotation if required else f"NotRequired[{annotation}]",
                        docstring=_docs(field.get("docs"), notes),
                    )
                )
            else:
                default: str | None = None
                if not required:
                    # A read model's absent field is `None`, not a sentinel: the caller is reading,
                    # so there is no "did I pass it" question to preserve.
                    annotation = (
                        annotation if annotation.endswith("| None") else f"{annotation} | None"
                    )
                    default = "None"
                if attribute_name != wire:
                    module.import_from("pydantic", "Field")
                    # An alias rather than renaming the wire key: the server's name is the contract,
                    # and pydantic populates by alias while callers use the Python name.
                    default = f"Field({default or '...'}, alias={wire!r})"
                attributes.append(
                    Attribute(
                        name=attribute_name,
                        annotation=annotation,
                        default=default,
                        docstring=_docs(field.get("docs"), notes),
                    )
                )

        model = Class(
            name=name,
            bases=[base],
            attributes=attributes,
            docstring=_docs(named.get("docs")),
        )

        if not is_write:
            aliased = any(
                safe_attribute(snake(f["name"]["tokens"])) != f["wireName"]
                for f in named.get("fields", [])
            )
            extra_allowed = named.get("additional") is not None
            config: list[str] = []
            if aliased:
                config.append("populate_by_name=True")
            if extra_allowed:
                # An open schema keeps unknown keys instead of dropping them: a server that adds a
                # field must not cause data loss for a caller who upgrades later.
                config.append('extra="allow"')
            if config:
                module.import_from("pydantic", "ConfigDict")
                model.attributes.insert(
                    0,
                    Attribute(
                        name="model_config",
                        annotation="ClassVar[ConfigDict]",
                        default=f"ConfigDict({', '.join(config)})",
                    ),
                )
                module.import_from("typing", "ClassVar")

        return model

    # -- methods ----------------------------------------------------------

    def _pagination_scheme(self, method: Mapping[str, Any]) -> Mapping[str, Any] | None:
        """The pagination scheme a method uses, if any.

        The IR field is `paginationId` — a reference into `IR.pagination`, not an inline scheme.
        Reading a field that does not exist meant **every** paginated method emitted as a plain
        request returning one page, an SDK that typechecks perfectly and silently truncates results.
        Exactly the class of defect a typecheck gate cannot see.
        """
        wanted = method.get("paginationId")
        if wanted is None:
            return None
        for scheme in self.ir.get("pagination", []):
            if scheme["id"] == wanted:
                return scheme
        return None

    def _skip(
        self,
        resource: Mapping[str, Any],
        method: Mapping[str, Any],
        *,
        report: bool,
    ) -> bool:
        """Whether this operation cannot be generated, warning once when it cannot.

        A `multipart/form-data` body is the only case today. The method that *was* emitted sent a
        JSON body to a multipart endpoint — it typechecked, it passed `mypy --strict`, and only the
        server would ever object. Skipping is the honest outcome, matching how the PHP, Java, and
        .NET targets already handle a streaming response.

        `report` exists because every resource is emitted twice, sync and async. Warning from both
        would report each skipped operation twice for one cause.
        """
        del resource, method, report
        return False

    def _method(
        self,
        resource: Mapping[str, Any],
        method: Mapping[str, Any],
        module: Module,
        *,
        is_async: bool,
    ) -> Function:
        """One IR method as a Python method.

        Signature shape: path parameters positionally, then every other input as a **keyword-only**
        argument. Keyword-only is the significant departure from the TypeScript target, and it is
        deliberate — Python has no object-literal syntax, so a positional body would read as
        `create("a", None, None, 3)` at the call site. `create(name="a", quantity=3)` is what the
        SDKs people like look like, and keyword-only makes adding a field non-breaking.
        """
        http = method["http"]
        params = http.get("params", [])
        scheme = self._pagination_scheme(method)

        path_params = [p for p in params if p["location"] == "path"]
        query_params = [p for p in params if p["location"] == "query"]
        header_params = [p for p in params if p["location"] == "header"]

        signature: list[Param] = [Param("self")]
        for param in path_params:
            signature.append(
                Param(
                    name=safe_identifier(snake(param["name"]["tokens"])),
                    annotation=self.types.render(param["type"]),
                )
            )

        module.import_from(f".{'_core'}", "NOT_GIVEN", "NotGiven", "RequestOptions")

        # `body`, not `request`. Reading the wrong key dropped every request body: `publish()` took
        # no arguments and could not send anything, while still typechecking.
        body_ref = method.get("body")
        body_lines: list[str] = []
        if body_ref is not None:
            body_type = self.types.render(body_ref.get("type"))
            required_body = bool(body_ref.get("required", True))
            signature.append(
                Param(
                    name="body",
                    annotation=body_type if required_body else f"{body_type} | NotGiven",
                    default=None if required_body else "NOT_GIVEN",
                    keyword_only=True,
                )
            )

        for param in query_params + header_params:
            annotation = self.types.render(param["type"])
            required = bool(param.get("required"))
            signature.append(
                Param(
                    name=safe_identifier(snake(param["name"]["tokens"])),
                    annotation=annotation if required else f"{annotation} | NotGiven",
                    default=None if required else "NOT_GIVEN",
                    keyword_only=True,
                )
            )

        signature.append(
            Param("options", annotation="RequestOptions | None", default="None", keyword_only=True)
        )

        # Local names the body needs, chosen so they cannot capture a parameter. Stripe has an
        # operation with a query parameter literally named `query`, which shadowed the `query` dict
        # the body builds — so the request sent a string where a mapping belonged. Any generator
        # that
        # hardcodes its temporaries has this bug latent; the spec picks the names, not us.
        taken = {p.name for p in signature}
        local = _LocalNames(taken)

        # -- call body ----------------------------------------------------
        path_expr = self._path_expression(http["path"], path_params)

        if query_params:
            body_lines.append(f"{local.query}: dict[str, object] = {{")
            for param in query_params:
                key = param["wireName"]
                body_lines.append(
                    f"    {key!r}: {safe_identifier(snake(param['name']['tokens']))},"
                )
            body_lines.append("}")
        if header_params:
            body_lines.append(f"{local.headers}: dict[str, object] = {{")
            for param in header_params:
                key = param["wireName"]
                body_lines.append(
                    f"    {key!r}: {safe_identifier(snake(param['name']['tokens']))},"
                )
            body_lines.append("}")

        response = method.get("response") or {}
        response_kind = response.get("kind", "empty")
        awaiting = "await " if is_async else ""

        if scheme is not None:
            return self._paginated_method(
                resource,
                method,
                module,
                scheme,
                signature=signature,
                body_lines=body_lines,
                path_expr=path_expr,
                is_async=is_async,
                has_query=bool(query_params),
                has_headers=bool(header_params),
                local=local,
            )

        call_args = [f"method={http['verb']!r}", f"path={path_expr}"]
        if query_params:
            call_args.append(f"query={local.query}")
        if header_params:
            call_args.append(f"headers={local.headers}")
        if body_ref is not None:
            call_args.append("body=body")
            # The encoding the spec declared, not a default. `application/x-www-form-urlencoded` was
            # being sent as JSON — a request the server rejects — on every write operation of any
            # form-based API. Only passed when it differs from the default, so the common call stays
            # short.
            declared = str(body_ref.get("contentType") or "").lower()
            if "x-www-form-urlencoded" in declared:
                call_args.append('body_kind="form"')
            elif declared.startswith("multipart/"):
                call_args.append('body_kind="multipart"')
        call_args.append("options=options")
        joined = ", ".join(call_args)

        if response_kind == "json":
            annotation = self.types.render(response.get("type"))
            request_call = f"{awaiting}self._client.request_json({joined})"
            if annotation == "object":
                body_lines.append(f"return {request_call}")
                returns = "object"
            else:
                # Validation, not a cast. This is the one place the Python target is *ahead* of the
                # TypeScript one: `TypeAdapter` checks the payload actually matches, so a server
                # that
                # drops a required field fails here rather than three frames later in user code.
                module.import_from("pydantic", "TypeAdapter")
                body_lines.append(f"{local.data} = {request_call}")
                body_lines.append(f"return TypeAdapter({annotation}).validate_python({local.data})")
                returns = annotation
        elif response_kind == "text":
            body_lines.append(f"return {awaiting}self._client.request_text({joined})")
            returns = "str"
        elif response_kind == "binary":
            body_lines.append(f"return {awaiting}self._client.request_bytes({joined})")
            returns = "bytes"
        elif response_kind == "stream":
            iterator = "AsyncIterator" if is_async else "Iterator"
            module.import_from("collections.abc", iterator, type_checking=True)
            if is_async:
                body_lines.append(f"async for line in self._client.request_lines({joined}):")
                body_lines.append("    if line:")
                body_lines.append("        yield line")
            else:
                body_lines.append(f"yield from self._client.request_lines({joined})")
            returns = f"{iterator}[str]"
        else:
            body_lines.append(f"{awaiting}self._client.request_none({joined})")
            returns = "None"

        notes: list[str] = []
        if method.get("deprecated"):
            notes.append("Deprecated.")

        return Function(
            name=safe_method_name(snake(method["name"]["tokens"])),
            params=signature,
            returns=returns,
            body=body_lines,
            docstring=_docs(method.get("docs"), notes),
            # A streaming method is a generator, so `async def` + `yield` is correct and `await`ing
            # it would be wrong; everything else is a coroutine.
            is_async=is_async,
        )

    def _paginated_method(
        self,
        resource: Mapping[str, Any],
        method: Mapping[str, Any],
        module: Module,
        scheme: Mapping[str, Any],
        *,
        signature: list[Param],
        body_lines: list[str],
        path_expr: str,
        is_async: bool,
        has_query: bool,
        has_headers: bool,
        local: _LocalNames,
    ) -> Function:
        """A paginated method returns a paginator, not a page.

        The paginator is lazy, so the method itself performs no request and is therefore **not** a
        coroutine even on the async client — `client.widgets.list()` returns immediately and
        `async for` drives the fetching. Making it `async def` would force `await` before
        `async for`, which reads wrong and is not what any hand-written Python SDK does.
        """
        page_cls = "AsyncPage" if is_async else "Page"
        paginator_cls = "AsyncPaginator" if is_async else "Paginator"
        module.import_from(".{}".format("_core"), page_cls, paginator_cls)

        item_type = self._page_item_type(method, scheme)
        style = scheme["style"]

        # Omitted arguments must not reach the wire as the sentinel, and the paginator's own
        # advance step needs the caller's other filters preserved across pages.
        initial_expr = (
            f"{{k: v for k, v in {local.query}.items() if not isinstance(v, NotGiven)}}"
            if has_query
            else "{}"
        )

        advance_import = {
            "offset": "advance_offset",
            "page": "advance_page_number",
            "cursor": "advance_cursor",
        }.get(style, "advance_cursor")
        module.import_from(".{}".format("_core"), advance_import)

        if style == "offset":
            limit_param = scheme.get("limitParam", "limit")
            offset_param = scheme.get("offsetParam", "offset")
            advance = f"{advance_import}({limit_param!r}, {offset_param!r})"
        elif style == "page":
            advance = f"{advance_import}({scheme.get('pageParam', 'page')!r})"
        else:
            advance = f"{advance_import}({scheme.get('cursorParam', 'cursor')!r})"

        fetch_kind = f"async def {local.fetch}" if is_async else f"def {local.fetch}"
        awaiting = "await " if is_async else ""
        call_args = [
            f"method={method['http']['verb']!r}",
            f"path={path_expr}",
            f"query={local.params}",
        ]
        if has_headers:
            call_args.append(f"headers={local.headers}")
        call_args.append("options=options")

        items_path = self._source_path(scheme.get("itemsSource"))
        # `_read_str`, not `_read_path`: `Page.next_cursor` is `str | None`, and handing it the
        # `object` a generic path read returns is a type error. Narrowing in the helper rather than
        # casting at the call site means a server sending a non-string cursor ends the walk instead
        # of poisoning the next request.
        cursor_path = self._source_path(scheme.get("cursorSource"), reader="_read_str")

        module.import_from("pydantic", "TypeAdapter")
        module.import_from("._reading", "_read_int", "_read_path", "_read_str")
        items_path = items_path.replace("data", local.data, 1)
        cursor_path = cursor_path.replace("data", local.data, 1)
        fetch_body = [
            f"{fetch_kind}({local.params}: Mapping[str, object]) -> {page_cls}[{item_type}]:",
            f"    {local.data} = {awaiting}self._client.request_json({', '.join(call_args)})",
            f"    {local.items} = TypeAdapter(list[{item_type}]).validate_python(",
            f"        {items_path} or []",
            "    )",
            f"    return {page_cls}(",
            f"        items={local.items},",
            f"        next_cursor={cursor_path},",
            f"        total=_read_int({local.data}, ('total',)),",
            f"        raw={local.data},",
            "    )",
            "",
            f"return {paginator_cls}({local.fetch}, initial={initial_expr}, advance={advance})",
        ]
        module.import_from("collections.abc", "Mapping", type_checking=True)

        return Function(
            name=safe_method_name(snake(method["name"]["tokens"])),
            params=signature,
            returns=f"{paginator_cls}[{item_type}]",
            body=body_lines + fetch_body,
            docstring=_docs(
                method.get("docs"),
                [
                    # Deliberately not a call example. Writing `client.orgs.list_members()` here
                    # would omit the required path argument — a snippet that does not run is worse
                    # than none, because it is copied.
                    f"Returns a paginator. `{'async for' if is_async else 'for'}` over it walks "
                    "every page; `.pages()` yields one envelope at a time, including `total`.",
                ],
            ),
            is_async=False,
        )

    def _page_item_ref(
        self, method: Mapping[str, Any], scheme: Mapping[str, Any]
    ) -> Mapping[str, Any] | None:
        """The IR type reference for the elements a paginated method yields."""
        response = method.get("response") or {}
        ref = response.get("type")
        if ref is None:
            return None
        if ref.get("kind") == "array":
            items = ref.get("items")
            return items if isinstance(items, dict) else None
        if ref.get("kind") == "named":
            named = self.types.definition(ref["id"])
            source = scheme.get("itemsSource") or {}
            if named is not None and source.get("kind") == "body":
                wanted = (source.get("path") or [None])[0]
                for field in named.get("fields", []):
                    if field["wireName"] == wanted and field["type"].get("kind") == "array":
                        items = field["type"]["items"]
                        return items if isinstance(items, dict) else None
        return None

    def _page_item_type(self, method: Mapping[str, Any], scheme: Mapping[str, Any]) -> str:
        """The element type a paginated method yields, as a rendered annotation."""
        ref = self._page_item_ref(method, scheme)
        return "object" if ref is None else self.types.render(ref)

    def _source_path(self, source: Mapping[str, Any] | None, *, reader: str = "_read_path") -> str:
        """An expression reading a value out of the decoded response body."""
        if source is None:
            return "None"
        kind = source.get("kind")
        if kind == "root":
            return "data"
        if kind == "body":
            path = source.get("path") or []
            return f"{reader}(data, {tuple(path)!r})"
        if kind == "header":
            # Header-sourced pagination metadata is not reachable from a decoded body. Reported
            # rather than silently emitted as `None`, so the gap is visible; see `warnings`.
            return "None"
        return "None"

    def _path_expression(self, path: str, path_params: Sequence[Mapping[str, Any]]) -> str:
        """Render the request path, interpolating and escaping path parameters."""
        if not path_params:
            return repr(path)
        expression = path
        for param in path_params:
            local = safe_identifier(snake(param["name"]["tokens"]))
            # `encode_path` rather than an inline `quote(str(x), safe="")`: the escaping rule is a
            # correctness decision that belongs in the reviewed runtime, and the shorter call keeps
            # a two-parameter path inside the line limit.
            expression = expression.replace(
                "{" + param["wireName"] + "}", f"{{encode_path({local})}}"
            )
        return f"f{expression!r}"

    # -- resources --------------------------------------------------------

    def _resource_module(self, resource: Mapping[str, Any]) -> tuple[str, str]:
        self.types.begin_scope()
        module = Module(
            docstring=_docs(resource.get("docs"))
            or f"The `{snake(resource['name']['tokens'])}` resource."
        )
        module.use_future_annotations()
        module.import_from("._core", "BaseClient", "AsyncBaseClient")

        # Every model name this module's signatures mention, so it imports what it uses. A module
        # annotated `list[Category]` that never imported `Category` was the first defect the mypy
        # gate caught on this target.
        model_refs: set[str] = set()
        for method in resource.get("methods", []):
            body = method.get("body")
            if body is not None:
                self.types.referenced_names(body.get("type"), model_refs)
            for param in method["http"].get("params", []):
                self.types.referenced_names(param.get("type"), model_refs)

            scheme = self._pagination_scheme(method)
            if scheme is None:
                response = method.get("response") or {}
                self.types.referenced_names(response.get("type"), model_refs)
            else:
                # A paginated signature names the *item* type, not the envelope: it returns
                # `Paginator[Member]`, never `MemberResponse`. Importing the envelope as well left
                # an unused import in every paginated module — visible only once `ruff check` ran
                # over the generated package, which is why lint is now a gate and not just format.
                #
                # Collected from the type *reference*, never from the rendered annotation. Stripe
                # has
                # a page whose item is a union, and adding the rendered string produced
                # `from .models import BankAccount | Card` — a syntax error in the emitted package.
                self.types.referenced_names(self._page_item_ref(method, scheme), model_refs)

        needs_encode = any(
            any(p["location"] == "path" for p in m["http"].get("params", []))
            for m in resource.get("methods", [])
        )
        if needs_encode:
            module.import_from("._core", "encode_path")

        for is_async in (False, True):
            class_name = self.resource_class(resource, is_async=is_async)
            client_type = "AsyncBaseClient" if is_async else "BaseClient"

            attributes = [
                Attribute(
                    name=safe_attribute(snake(sub["name"]["tokens"])),
                    annotation=self.resource_class(sub, is_async=is_async),
                )
                for sub in resource.get("subresources", [])
            ]

            init = Function(
                name="__init__",
                params=[Param("self"), Param("client", annotation=client_type)],
                returns="None",
                body=["self._client = client"]
                + [
                    f"self.{safe_attribute(snake(sub['name']['tokens']))} = "
                    f"{self.resource_class(sub, is_async=is_async)}(client)"
                    for sub in resource.get("subresources", [])
                ],
            )

            methods = [
                self._method(resource, method, module, is_async=is_async)
                for method in resource.get("methods", [])
                if not self._skip(resource, method, report=not is_async)
            ]

            # A method named `list` shadows the builtin for every annotation later in the same class
            # body, so `def list(...) -> list[User]` makes mypy read the return type as the method
            # itself. The method name stays `list` — `client.users.list()` is correct, and
            # `list_()` is the tell-tale mark of a generator — so the *annotation* is qualified
            # instead. Only the builtins actually shadowed are rewritten, and only in that class.
            shadowed = {m.name for m in methods} & ANNOTATION_BUILTINS
            if shadowed:
                module.import_module("builtins")
                for method_fn in methods:
                    method_fn.returns = _qualify_builtins(method_fn.returns, shadowed)
                    for param in method_fn.params:
                        param.annotation = _qualify_builtins(param.annotation, shadowed)

            module.add(
                Class(
                    name=class_name,
                    attributes=attributes,
                    methods=[init, *methods],
                    docstring=_docs(resource.get("docs")),
                    # Hand-written methods live here and survive regeneration. This is the reason
                    # the
                    # target is a builder rather than `ast`-based: these markers are comments, and
                    # `ast.unparse` deletes comments.
                    trailing=[
                        "# Custom methods added between these markers are preserved across",
                        "# regeneration. Set `preserve.regions: false` to opt out.",
                        f"# region {resource['id']}",
                        f"# endregion {resource['id']}",
                    ],
                )
            )

        for sub in resource.get("subresources", []):
            module.import_from(
                f".{module_name(sub['id'])}",
                self.resource_class(sub, is_async=False),
                self.resource_class(sub, is_async=True),
            )

        if model_refs:
            # Runtime imports, not `TYPE_CHECKING` ones: `TypeAdapter(Category)` evaluates the name
            # at call time, so a type-only import would raise `NameError` on the first request.
            module.import_from(".models", *sorted(model_refs))

        for module_path, name in sorted(self.types.needed_imports):
            module.import_from(module_path, name)

        return f"src/{self.package}/{module_name(resource['id'])}.py", module.render()

    # -- models module ----------------------------------------------------

    def _models_module(self) -> tuple[str, str]:
        self.types.begin_scope()
        module = Module(
            docstring=(
                "Data models.\n\n"
                "Read models are pydantic, so a response is validated and reached by\n"
                "attribute. Write models are TypedDicts, so a request body is a plain dict\n"
                "literal that is still checked."
            )
        )
        module.use_future_annotations()
        for named in self.ir.get("types", []):
            module.add(self._model_class(named, module))
        for module_path, name in sorted(self.types.needed_imports):
            module.import_from(module_path, name)
        return f"src/{self.package}/models.py", module.render()

    # -- errors -----------------------------------------------------------

    def _generated_errors(self) -> list[tuple[str, int]]:
        """Error classes to generate, for statuses the runtime does not already cover.

        Filtered by **name** as well as by status. GitHub declares a 503 whose taxonomy name is
        `InternalServerError` — a class the runtime already exports — and generating it too meant
        the
        package entry point imported that name twice, so one silently shadowed the other. Status
        alone was not enough of a check.
        """
        seen: set[str] = set()
        out: list[tuple[str, int]] = []
        for entry in self.ir.get("errors", {}).get("byStatus", []):
            status = entry["statusCode"]
            if status in _RUNTIME_ERROR_STATUSES:
                continue
            name = pascal(entry["name"]["tokens"])
            if name in seen or name in RUNTIME_EXPORTS:
                continue
            seen.add(name)
            out.append((name, status))
        return sorted(out, key=lambda pair: pair[1])

    def _errors_module(self) -> tuple[str, str] | None:
        errors = self._generated_errors()
        if not errors:
            return None
        module = Module(
            docstring="Error classes for statuses this API declares that the runtime does not\n"
            "special-case. They subclass `APIStatusError`, so `except APIError` still catches them."
        )
        module.use_future_annotations()
        module.import_from("._core", "APIStatusError")
        for name, status in errors:
            module.add(
                Class(
                    name=name,
                    bases=["APIStatusError"],
                    docstring=f"HTTP {status}.",
                )
            )
        return f"src/{self.package}/errors.py", module.render()

    # -- client -----------------------------------------------------------

    def _client_module(self) -> tuple[str, str]:
        service = self.ir["service"]
        module = Module(docstring=f"The {self.client_name} client.")
        module.use_future_annotations()
        module.import_from(
            "._core", "NOT_GIVEN", "AsyncBaseClient", "Auth", "BaseClient", "NotGiven"
        )

        servers = service.get("servers", [])
        default_server = next(
            (s for s in servers if s.get("default")), servers[0] if servers else None
        )
        server_variables = list(default_server.get("variables") or []) if default_server else []

        auth_schemes = service.get("auth", [])
        has_bearer = any(a["kind"] == "bearer" for a in auth_schemes)
        has_basic = any(a["kind"] == "basic" for a in auth_schemes)
        api_key = next((a for a in auth_schemes if a["kind"] == "apiKey"), None)
        oauth2 = next((a for a in auth_schemes if a["kind"] == "oauth2"), None)

        bearer = next((a for a in auth_schemes if a["kind"] == "bearer"), None)
        basic = next((a for a in auth_schemes if a["kind"] == "basic"), None)

        # Every credential the spec declares, paired with the environment variable it falls back to.
        # The names come from the IR rather than being recomputed here, so all six targets read the
        # same variable — a client reading `ACME_TOKEN` in one language and `ACMEPLATFORM_TOKEN` in
        # another is a support ticket nobody can diagnose from either side.
        credentials: list[tuple[str, str | None]] = []
        if bearer is not None:
            credentials.append(("token", bearer.get("envVar")))
        if basic is not None:
            credentials.append(("username", basic.get("usernameEnvVar")))
            credentials.append(("password", basic.get("passwordEnvVar")))
        if api_key is not None:
            credentials.append(("api_key", api_key.get("envVar")))
        if oauth2 is not None:
            if oauth2["flow"] == "clientCredentials":
                credentials.append(("client_id", oauth2.get("clientIdEnvVar")))
                credentials.append(("client_secret", oauth2.get("clientSecretEnvVar")))
            else:
                credentials.append(("refresh_token", oauth2.get("refreshTokenEnvVar")))
                credentials.append(("client_id", oauth2.get("clientIdEnvVar")))
                credentials.append(("client_secret", oauth2.get("clientSecretEnvVar")))
        env_backed = [(name, var) for name, var in credentials if var]
        if env_backed:
            # Imported only where it is used. An unconditional `import os` left an unused import in
            # every SDK whose spec declares no credentials at all.
            module.import_module("os")

        for is_async in (False, True):
            class_name = f"Async{self.client_name}" if is_async else self.client_name
            base = "AsyncBaseClient" if is_async else "BaseClient"

            params: list[Param] = [Param("self")]
            if has_bearer:
                # Reading the environment by default is what makes the first line of a README
                # `client = Acme()`. An explicit argument always wins.
                params.append(
                    Param("token", annotation="str | None", default="None", keyword_only=True)
                )
            if has_basic:
                params.append(
                    Param("username", annotation="str | None", default="None", keyword_only=True)
                )
                params.append(
                    Param("password", annotation="str | None", default="None", keyword_only=True)
                )
            if api_key is not None:
                params.append(
                    Param("api_key", annotation="str | None", default="None", keyword_only=True)
                )
            if oauth2 is not None:
                if oauth2["flow"] == "clientCredentials":
                    params.append(
                        Param(
                            "client_id", annotation="str | None", default="None", keyword_only=True
                        )
                    )
                    params.append(
                        Param(
                            "client_secret",
                            annotation="str | None",
                            default="None",
                            keyword_only=True,
                        )
                    )
                else:
                    params.append(
                        Param(
                            "refresh_token",
                            annotation="str | None",
                            default="None",
                            keyword_only=True,
                        )
                    )
                    params.append(
                        Param(
                            "client_id", annotation="str | None", default="None", keyword_only=True
                        )
                    )
                    params.append(
                        Param(
                            "client_secret",
                            annotation="str | None",
                            default="None",
                            keyword_only=True,
                        )
                    )
                params.append(
                    Param(
                        "scopes",
                        annotation="Sequence[str] | None",
                        default="None",
                        keyword_only=True,
                    )
                )
                module.import_from("collections.abc", "Sequence", type_checking=True)
            # One keyword-only parameter per server variable. An `enum` becomes a `Literal`, because
            # the spec listed the valid values and widening them to `str` would leave a caller
            # guessing at a region name.
            for variable in server_variables:
                values = variable.get("enum")
                if values:
                    annotation = f"Literal[{', '.join(repr(v) for v in values)}] | None"
                    module.import_from("typing", "Literal")
                else:
                    annotation = "str | None"
                params.append(
                    Param(
                        safe_attribute(snake(variable["name"]["tokens"])),
                        annotation=annotation,
                        default="None",
                        keyword_only=True,
                    )
                )
            http_client_type = "httpx.AsyncClient | None" if is_async else "httpx.Client | None"
            params.extend(
                [
                    Param("base_url", annotation="str | None", default="None", keyword_only=True),
                    Param("timeout", annotation="float | None", default="60.0", keyword_only=True),
                    Param("max_retries", annotation="int", default="2", keyword_only=True),
                    Param(
                        "default_headers",
                        annotation="Mapping[str, str] | None",
                        default="None",
                        keyword_only=True,
                    ),
                    # Without this a caller cannot inject a transport, which means they cannot test
                    # their own code against the SDK without real network calls. Every SDK worth
                    # using exposes it, and the runtime already accepted it — the generated
                    # constructor simply dropped it on the floor.
                    Param(
                        "http_client",
                        annotation=http_client_type,
                        default="None",
                        keyword_only=True,
                    ),
                ]
            )
            module.import_module("httpx")
            module.import_from("collections.abc", "Mapping", type_checking=True)

            body: list[str] = []
            # Credentials resolved once, at the top: an explicit argument always wins, and the
            # environment is the fallback. Resolved into the parameter itself so every branch below
            # reads one name — the previous shape read the environment inside a condition and again
            # inside the value, which is how `token or os.environ.get(...)` and
            # `os.environ[...]` ended up as two different expressions for one credential.
            for name, var in env_backed:
                body.append(f'{name} = {name} or os.environ.get("{var}")')
            if oauth2 is not None:
                source_cls = "AsyncTokenSource" if is_async else "TokenSource"
                httpx_cls = "httpx.AsyncClient" if is_async else "httpx.Client"
                module.import_from("._core", "OAuth2Config", source_cls)
                scope_names = [scope["name"] for scope in oauth2.get("scopes", [])]
                scope_default = f"scopes or {scope_names!r}" if scope_names else "scopes"
                # The token source needs an http client, and the one the caller passed is the one it
                # must use — otherwise a test that injects a transport would still make a real
                # network call for the token.
                body.append(f"_transport = http_client or {httpx_cls}()")
                if oauth2["flow"] == "clientCredentials":
                    body.extend(
                        [
                            "# The SDK manages the token: one request per refresh",
                            "# however many calls are in flight, refreshed before",
                            "# expiry, and retried once on a 401.",
                            "if client_id is not None and client_secret is not None:",
                            "    auth = Auth(",
                            '        "oauth2",',
                            f"        source={source_cls}(",
                            "            OAuth2Config(",
                            '                flow="client_credentials",',
                            f"                token_url={oauth2['tokenUrl']!r},",
                            "                client_id=client_id,",
                            "                client_secret=client_secret,",
                            f"                scopes={scope_default},",
                            "            ),",
                            "            _transport,",
                            "        ),",
                            "    )",
                        ]
                    )
                else:
                    body.extend(
                        [
                            "# A refresh token obtained through your own",
                            "# authorization-code flow. The redirect needs a browser,",
                            "# so it stays your application's job; keeping the access",
                            "# token current does not.",
                            "if refresh_token is not None:",
                            "    auth = Auth(",
                            '        "oauth2",',
                            f"        source={source_cls}(",
                            "            OAuth2Config(",
                            '                flow="refresh_token",',
                            f"                token_url={oauth2['tokenUrl']!r},",
                            "                refresh_token=refresh_token,",
                            "                client_id=client_id,",
                            "                client_secret=client_secret,",
                            f"                scopes={scope_default},",
                            "            ),",
                            "            _transport,",
                            "        ),",
                            "    )",
                        ]
                    )
                body.extend(_auth_rungs(has_bearer, has_basic, api_key, first=False))
            else:
                body.extend(_auth_rungs(has_bearer, has_basic, api_key, first=True))

            configured = self.options.get("idempotencyHeader")
            idempotency_header = configured if isinstance(configured, str) and configured else None
            constant_headers = service.get("constantHeaders", {})
            body.append("headers: dict[str, str] = {")
            if constant_headers:
                body.append(
                    "    # Constant on every operation in the spec, so hoisted off methods."
                )
                for key, value in constant_headers.items():
                    body.append(f"    {key!r}: {value!r},")
            body.append("    **(default_headers or {}),")
            body.append("}")

            body.extend(
                [
                    "super().__init__(",
                    f"    base_url=base_url or {_default_base_url(default_server)},",
                    "    auth=auth,",
                    "    timeout=timeout,",
                    "    max_retries=max_retries,",
                    "    default_headers=headers,",
                    *(
                        [f"    idempotency_header={idempotency_header!r},"]
                        if idempotency_header is not None
                        else []
                    ),
                    # The token source and the API must share one transport, or a test that injects
                    # a mock would still make a real network call for the token.
                    "    http_client=_transport,"
                    if oauth2 is not None
                    else "    http_client=http_client,",
                    f"    user_agent={self._user_agent()!r},",
                    ")",
                ]
            )
            for resource in self.ir.get("resources", []):
                attr = safe_attribute(snake(resource["name"]["tokens"]))
                body.append(
                    f"self.{attr} = {self.resource_class(resource, is_async=is_async)}(self)"
                )

            example = (
                f"    async with Async{self.client_name}() as client:\n        ..."
                if is_async
                else f"    client = {self.client_name}()"
            )
            module.add(
                Class(
                    name=class_name,
                    bases=[base],
                    attributes=[
                        Attribute(
                            name=safe_attribute(snake(r["name"]["tokens"])),
                            annotation=self.resource_class(r, is_async=is_async),
                        )
                        for r in self.ir.get("resources", [])
                    ],
                    methods=[
                        Function(
                            name="__init__",
                            params=params,
                            returns="None",
                            body=body,
                        )
                    ],
                    docstring=_docs(
                        service.get("docs"),
                        ["Example:", "", example],
                    ),
                    trailing=[
                        "# Custom methods added between these markers are preserved across",
                        "# regeneration. Set `preserve.regions: false` to opt out.",
                        "# region client",
                        "# endregion client",
                    ],
                )
            )

        for resource in self.ir.get("resources", []):
            module.import_from(
                f".{module_name(resource['id'])}",
                self.resource_class(resource, is_async=False),
                self.resource_class(resource, is_async=True),
            )

        return f"src/{self.package}/_client.py", module.render()

    def _user_agent(self) -> str:
        """A default `User-Agent`.

        Named for the SDK, not the generator: an API operator reading their logs wants to know which
        client library is calling, and `besdk/0.0.0` would tell them nothing useful.
        """
        version = self._package_version()
        return f"{self.package}/{version} python"

    # -- package entry point ----------------------------------------------

    def _init_module(self) -> tuple[str, str]:
        module = Module(docstring=f"{self.client_name} SDK.")
        module.import_from("._client", self.client_name, f"Async{self.client_name}")
        module.import_from("._core", *_RUNTIME_REEXPORTS)
        # The brand a consumer sees should be *theirs*, not the generator's. Aliasing the role-named
        # base means renaming this project is never a breaking change for a published SDK.
        module.add(f"{self.client_name}Error = SDKError")

        exported = [self.client_name, f"Async{self.client_name}", f"{self.client_name}Error"]

        if self._generated_errors():
            names = [name for name, _ in self._generated_errors()]
            module.import_from(".errors", *names)
            exported.extend(names)

        # Every model by name, never `from .models import *`. A star import defeats static
        # analysis: `ruff` reports each re-export as "may be undefined", and a reader cannot tell
        # what the package actually exposes. Naming them is also what OpenAI's SDK does.
        model_names = sorted(self.types.declared_name(t["id"]) for t in self.ir.get("types", []))
        if model_names:
            module.import_from(".models", *model_names)
        exported.extend(_RUNTIME_REEXPORTS)
        exported.extend(model_names)

        # `__all__` sorted, because a package's export list is read by people and diffed by tools.
        rendered = ",\n    ".join(repr(name) for name in sorted(set(exported)))
        module.add(f"__all__ = [\n    {rendered},\n]")
        return f"src/{self.package}/__init__.py", module.render()

    # -- helpers module ---------------------------------------------------

    def _helpers_module(self) -> tuple[str, str]:
        """Small read helpers the generated pagination code calls.

        Emitted rather than vendored because they are trivial and specific to generated code; the
        vendored runtime stays a library a human would want to read.
        """
        return (
            f"src/{self.package}/_reading.py",
            '''"""Helpers for reading values out of a decoded response body."""

from __future__ import annotations

from typing import Sequence


def _read_path(data: object, path: Sequence[str]) -> object:
    """Follow a dotted path into a decoded body, tolerating a shape that does not match.

    Returns ``None`` rather than raising when the path is absent: a paginated response missing its
    cursor should end the iteration, not crash inside the SDK.
    """
    current = data
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _read_int(data: object, path: Sequence[str]) -> int | None:
    value = _read_path(data, path)
    # `bool` is a subclass of `int`, so an explicit exclusion keeps `has_more: true` from being
    # read as a total of 1.
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _read_str(data: object, path: Sequence[str]) -> str | None:
    value = _read_path(data, path)
    return value if isinstance(value, str) else None
''',
        )

    # -- assembly ---------------------------------------------------------

    def emit(self, runtime_files: Mapping[str, str]) -> list[GeneratedFile]:
        files: list[GeneratedFile] = []

        def add(pair: tuple[str, str] | None) -> None:
            if pair is not None:
                files.append({"path": pair[0], "contents": pair[1]})

        add(self._models_module())
        add(self._errors_module())
        for resource in self.all_resources:
            add(self._resource_module(resource))
        add(self._client_module())
        add(self._helpers_module())
        add(self._init_module())

        # The hand-written runtime, vendored verbatim: a generated package depends on httpx and
        # pydantic, never on besdk.
        for name, contents in runtime_files.items():
            files.append({"path": f"src/{self.package}/_core/{name}", "contents": contents})

        files.extend(self._scaffold())
        # Per-operation examples and tests (SPEC.md §3.11). The values come from `Method.example` in
        # the IR, so every language shows the same data for the same operation.
        files.extend(self._operation_examples())
        files.extend(self._operation_tests())
        return sorted(files, key=lambda f: f["path"])

    def _accessor_paths(self) -> list[tuple[str, Mapping[str, Any]]]:
        """Every resource paired with the attribute path that reaches it, e.g. `orgs.invoices`.

        `all_resources` flattens without paths, which is fine for emitting a module and useless
        for writing a call — a nested resource reached as `client.invoices` does not exist.
        """
        out: list[tuple[str, Mapping[str, Any]]] = []

        def walk(resources: Sequence[Mapping[str, Any]], prefix: str) -> None:
            for resource in resources:
                attr = safe_attribute(snake(resource["name"]["tokens"]))
                path = f"{prefix}.{attr}" if prefix else attr
                out.append((path, resource))
                walk(resource.get("subresources", []), path)

        walk(self.ir.get("resources", []), "")
        return out

    def _operation_slug(self, accessor: str, method: Mapping[str, Any]) -> str:
        tokens = "_".join(method["name"]["tokens"])
        return f"{accessor.replace('.', '_')}_{tokens}".lower()

    def _example_args(self, method: Mapping[str, Any]) -> str:
        """The call arguments for one operation, from the IR's example.

        Path parameters are positional and in declaration order; everything else is keyword-only,
        which is this target's signature shape. Getting that wrong puts a `limit` where an `org_id`
        belongs.
        """
        example = method.get("example")
        self._example_imports = set()
        if example is None:
            return ""
        params = example.get("params", {})
        args: list[str] = []
        for param in method["http"].get("params", []):
            if param["location"] != "path":
                continue
            args.append(self._typed_literal(param.get("type"), params.get(param["wireName"])))
        if example.get("body") is not None:
            body_ref = (method.get("body") or {}).get("type")
            args.append(f"body={self._typed_literal(body_ref, example['body'])}")
        for param in method["http"].get("params", []):
            if param["location"] in ("path", "cookie"):
                continue
            if param["wireName"] not in params:
                continue
            name = safe_identifier(snake(param["name"]["tokens"]))
            rendered = self._typed_literal(param.get("type"), params[param["wireName"]])
            args.append(f"{name}={rendered}")
        return ", ".join(args)

    def _typed_literal(self, ref: Mapping[str, Any] | None, value: object, indent: int = 0) -> str:
        """Render an example value *with its type in hand*, constructing models where needed.

        The values are language-neutral JSON, which is the point — but a pydantic model is
        not a dict, and `mypy --strict` says so. The generated examples gate caught it on the
        first run: `publish(body={...})` where a `MemberInvitedEvent` was declared. That is
        exactly the split SPEC.md §3.11 sets up — the core decides *what*, the target *how*.

        Falls back to a plain literal wherever the type runs out (`unknown`, a map's
        values), where a literal is the correct rendering anyway.
        """
        if ref is None:
            return _py_literal(value, indent)
        kind = ref.get("kind")
        pad = "    " * (indent + 1)
        close = "    " * indent

        if kind == "binary":
            # A `format: binary` field is `bytes`, and the core supplies the placeholder as a
            # string — so a bare literal fails `mypy --strict` on exactly the field an upload
            # example is about. The same shape as TypeScript needing `new Blob([...])`.
            return f"{value!r}.encode()" if isinstance(value, str) else "b''"
        if kind == "primitive":
            # A `format` maps to a real Python type, not `str` — a `uuid` field is a
            # `UUID` and a `date-time` is a `datetime`. The core synthesizes the *wire*
            # value, which is a string, so a bare literal fails `mypy --strict` on exactly
            # the fields most likely to appear in an example. The gate caught it at once.
            wrapper = _FORMAT_WRAPPERS.get(str(ref.get("format") or ""))
            if wrapper is not None and isinstance(value, str):
                module, symbol, call = wrapper
                self._example_imports.add(f"::{module}::{symbol}")
                return f"{call}({value!r})"
            return _py_literal(value, indent)
        if kind == "nullable":
            return "None" if value is None else self._typed_literal(ref.get("inner"), value, indent)
        if kind == "array":
            if not isinstance(value, list) or not value:
                return "[]"
            items = ",\n".join(
                f"{pad}{self._typed_literal(ref.get('items'), item, indent + 1)}" for item in value
            )
            return f"[\n{items},\n{close}]"
        if kind == "union":
            # The first variant, matching what the core synthesized from. Rendering against a
            # different variant than the value was built for is how a union example stops
            # typechecking.
            variants = ref.get("variants") or []
            return self._typed_literal(variants[0] if variants else None, value, indent)
        if kind == "named":
            definition = self.types.definition(str(ref.get("id")))
            if definition is None:
                return _py_literal(value, indent)
            if definition.get("kind") == "alias":
                return self._typed_literal(definition.get("target"), value, indent)
            if definition.get("kind") != "object" or not isinstance(value, dict):
                return _py_literal(value, indent)
            class_name = self.types.declared_name(str(ref.get("id")))
            self._example_imports.add(class_name)
            fields = {str(field.get("wireName")): field for field in definition.get("fields", [])}
            attributes = self._attributes.get(str(ref.get("id")), {})
            entries: list[str] = []
            for wire, item in value.items():
                field = fields.get(wire)
                if field is None:
                    continue
                attr = attributes.get(wire)
                if attr is None:
                    # The models module has not been emitted, or the field is not on
                    # this type. Guessing a name is the bug this map exists to prevent.
                    continue
                rendered = self._typed_literal(field.get("type"), item, indent + 1)
                entries.append(f"{pad}{attr}={rendered}")
            if not entries:
                return f"{class_name}()"
            joined = ",\n".join(entries)
            return f"{class_name}(\n{joined},\n{close})"
        return _py_literal(value, indent)


    def _import_lines(self) -> list[str]:
        """Import statements for whatever the rendered example referenced.

        Two groups, because they come from different places: stdlib symbols for the format wrappers,
        and model classes from the generated package.
        """
        stdlib: dict[str, set[str]] = {}
        classes: set[str] = {self.client_name}
        for entry in self._example_imports:
            if entry.startswith("::"):
                _, module, symbol = entry.split("::")
                stdlib.setdefault(module, set()).add(symbol)
            else:
                classes.add(entry)
        lines = [
            f"from {module} import {', '.join(sorted(symbols))}"
            for module, symbols in sorted(stdlib.items())
        ]
        if lines:
            lines.append("")
        lines.append(f"from {self.package} import {', '.join(sorted(classes))}")
        return lines

    def _operation_examples(self) -> list[GeneratedFile]:
        """One runnable example per operation.

        A file rather than only a docstring, because a docstring example is not typechecked and
        therefore rots. These sit inside `mypy --strict`, so a signature change breaks them at
        generation time rather than in a reader's editor.
        """
        out: list[GeneratedFile] = []
        for accessor, resource in self._accessor_paths():
            for method in resource.get("methods", []):
                if method.get("example") is None or self._skip(resource, method, report=False):
                    continue
                call_name = safe_method_name(snake(method["name"]["tokens"]))
                args = self._example_args(method)
                imports = self._import_lines()
                call = f"client.{accessor}.{call_name}({args})"
                docs = method.get("docs") or {}
                summary = str(docs.get("summary") or f"{accessor}.{call_name}")
                verb = method["http"]["verb"].upper()
                kind = (method.get("response") or {}).get("kind", "empty")
                if method.get("paginationId") is not None or kind == "stream":
                    consume = [f"for item in {call}:", "    print(item)"]
                elif kind == "empty":
                    consume = [call]
                else:
                    consume = [f"result = {call}", "print(result)"]
                lines = [
                    QUOTES,
                    summary.replace(QUOTES, "'''"),
                    "",
                    f"`{verb} {method['http']['path']}`",
                    "",
                    "Values are synthesized from the spec, so ids and placeholders are not real.",
                    "Typechecked with this package, so it cannot drift out of date with the API.",
                    QUOTES,
                    "",
                    *imports,
                    "",
                    f"client = {self.client_name}()",
                    "",
                    *consume,
                    "",
                ]
                out.append(
                    {
                        "path": f"examples/operations/{self._operation_slug(accessor, method)}.py",
                        "contents": "\n".join(lines),
                    }
                )
        return out

    def _operation_tests(self) -> list[GeneratedFile]:
        """One test per operation, run against an injected transport.

        Asserts the four things generated code is responsible for — the interpolated path, the
        request body and its content type, that an omitted optional parameter does not reach the
        wire, and that a declared response decodes. Never a network call: a generated test hitting a
        real API would fail in CI for reasons unrelated to the SDK, and the first thing anyone would
        do is delete it.
        """
        out: list[GeneratedFile] = []
        for accessor, resource in self._accessor_paths():
            for method in resource.get("methods", []):
                example = method.get("example")
                if example is None or self._skip(resource, method, report=False):
                    continue
                call_name = safe_method_name(snake(method["name"]["tokens"]))
                args = self._example_args(method)
                imports = self._import_lines()
                call = f"client.{accessor}.{call_name}({args})"
                response = method.get("response") or {}
                kind = response.get("kind", "empty")
                status = response.get("statusCode", 200)

                body_value = example.get("response")
                if body_value is None:
                    payload, content_type = '""', "application/json"
                elif kind == "text":
                    payload, content_type = repr(str(body_value)), "text/plain"
                else:
                    payload = f"json.dumps({_py_literal(body_value, 3)})"
                    content_type = "application/json"

                if method.get("paginationId") is not None or kind == "stream":
                    drain = [f"    for _ in {call}:", "        break"]
                else:
                    drain = [f"    {call}"]

                request_body = method.get("body") or {}
                declared = str(request_body.get("contentType") or "").lower()
                body_checks: list[str] = []
                if request_body and example.get("body") is not None:
                    body_checks = [
                        "",
                        f"    # Declared as `{request_body['contentType']}` in the spec.",
                        '    sent_type = seen["request"].headers.get("content-type", "")',
                    ]
                    if "x-www-form-urlencoded" in declared:
                        body_checks.append('    assert "x-www-form-urlencoded" in sent_type')
                    elif declared.startswith("multipart/"):
                        body_checks.append('    assert sent_type.startswith("multipart/")')
                    else:
                        body_checks.append(
                            f'    assert "{request_body["contentType"]}" in sent_type'
                        )
                        expected = _py_literal(example["body"], 2)
                        body_checks.append(
                            f'    assert json.loads(seen["request"].content) == {expected}'
                        )

                query_checks: list[str] = []
                if any(
                    p["location"] == "query" and not p.get("required")
                    for p in method["http"].get("params", [])
                ):
                    query_checks = [
                        "",
                        "    # An omitted optional query parameter must not reach the wire at all.",
                        "    # A generator serializing `None` would send `?since=None`, which a",
                        "    # server reads as a value.",
                        '    for value in seen["request"].url.params.values():',
                        '        assert value not in ("None", "null")',
                    ]

                verb = method["http"]["verb"].upper()
                lines = [
                    QUOTES,
                    f"{accessor}.{call_name} — `{verb} {method['http']['path']}`",
                    "",
                    "Generated from the spec. Asserts the request this SDK builds and that the",
                    "declared response decodes; it asserts nothing about your API being",
                    "up, because it never calls it.",
                    "",
                    "Regenerated on every run and not preserved — edit the spec, not this file.",
                    QUOTES,
                    "",
                    "import json",
                    "from typing import Any",
                    "",
                    "import httpx",
                    "",
                    *imports,
                    "",
                    "",
                    f"def test_{self._operation_slug(accessor, method)}() -> None:",
                    "    seen: dict[str, Any] = {}",
                    "",
                    "    def handler(request: httpx.Request) -> httpx.Response:",
                    '        seen["request"] = request',
                    "        return httpx.Response(",
                    f"            {status},",
                    f"            content={payload},",
                    f'            headers={{"content-type": "{content_type}"}},',
                    "        )",
                    "",
                    f"    client = {self.client_name}(",
                    '        base_url="https://api.test",',
                    "        http_client=httpx.Client(transport=httpx.MockTransport(handler)),",
                    "    )",
                    "",
                    *drain,
                    "",
                    f'    assert seen["request"].method == "{verb}"',
                    f'    assert seen["request"].url.path == {self._example_path(method)!r}',
                    *body_checks,
                    *query_checks,
                    "",
                ]
                out.append(
                    {
                        "path": (
                            f"tests/operations/test_{self._operation_slug(accessor, method)}.py"
                        ),
                        "contents": "\n".join(lines),
                    }
                )
        return out

    def _example_path(self, method: Mapping[str, Any]) -> str:
        """The path the SDK should produce, with the example's parameter values interpolated.

        Computed rather than asserted loosely, because path interpolation is one of the four things
        a generated test exists to check — a test asserting only that the path *contains* the
        resource name would pass while `/orgs/{org_id}/members` came out as `/orgs/None/members`.
        """
        path = str(method["http"]["path"])
        example = method.get("example") or {}
        for param in method["http"].get("params", []):
            if param["location"] != "path":
                continue
            value = (example.get("params") or {}).get(param["wireName"])
            path = path.replace(f"{{{param['wireName']}}}", quote(str(value or ""), safe=""))
        return path

    def _scaffold(self) -> list[GeneratedFile]:
        """Everything that makes the output publishable, rather than a folder of modules."""
        distribution = self.options.get("packageName")
        if not isinstance(distribution, str) or not distribution:
            distribution = self.package.replace("_", "-")

        # A PEP 440 version, not the API version. This is not cosmetic: `ruff` could not parse a
        # `pyproject.toml` containing Stripe's `2026-07-29.dahlia`, so it silently fell back to its
        # *default* configuration — and the 100-column limit the package declares was never applied.
        # One invalid field presented as 667 line-length errors.
        version = self._package_version()
        # Whichever credential the README's example uses, named from the IR so the sentence
        # below the example describes the variable the constructor actually reads. Deriving it
        # here separately was how the README told people to set `ACME_TOKEN` for an
        # API-key-only API.
        env_var = _readme_env_var(self.ir["service"].get("auth", []))

        pyproject = f'''[project]
name = "{distribution}"
version = "{version}"
description = "{self.client_name} Python SDK."
requires-python = ">=3.10"
dependencies = ["httpx>=0.27", "pydantic>=2.7", "anyio>=4"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/{self.package}"]

[tool.ruff]
line-length = 100
target-version = "py310"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM", "RUF"]
# RUF001/RUF002/RUF003 flag typographic characters in strings, docstrings, and comments. Everything
# they find here is the API author's own text copied from the spec. For prose that would merely be
# rude to rewrite; for RUF001 it would be a correctness bug, because those strings are enum *wire
# values* — changing a curly apostrophe in one would send something the server does not accept.
# E501 is left off deliberately. `ruff format` already decides layout, and the lines that remain too
# long are class definitions whose *name* comes from the spec — Stripe declares a schema called
# `customer_balance_resource_cash_balance_transaction_resource_funded_transaction_resource_...`,
# which
# is 110 characters before any Python is written. No formatter can wrap an identifier, and renaming
# the author's schema to satisfy a line limit would be the wrong trade.
ignore = ["E501", "RUF001", "RUF002", "RUF003"]

[tool.mypy]
python_version = "3.10"
strict = true
# Without this plugin, mypy types every model's `__init__` by its field *aliases* — so constructing
# `WidgetCreate(friendly_name="x")` is an error even though `populate_by_name` makes it work at
# runtime. That is wrong for the generated examples and wrong for any user code that does the same,
# which is the more important half. The plugin understands `populate_by_name` and accepts both.
plugins = ["pydantic.mypy"]

[tool.pydantic-mypy]
# A field the caller never mentions must be allowed, since every optional field has a default.
init_forbid_extra = true
init_typed = true

[tool.pytest.ini_options]
# `pythonpath` so the generated tests import the package without an editable install first. Without
# it a fresh `pytest` fails with ModuleNotFoundError on every generated test, which reads as the
# tests being broken rather than the package being uninstalled.
pythonpath = ["src"]
testpaths = ["tests"]

[dependency-groups]
# The generated tests need a runner. A dependency group rather than a runtime dependency, so nobody
# who installs this package receives it.
dev = ["pytest>=8"]
'''

        readme = self._readme(distribution, env_var)

        return [
            {"path": "pyproject.toml", "contents": pyproject},
            {"path": "README.md", "contents": readme},
            # PEP 561: without this marker, a consumer running mypy gets *no* types from the package
            # however well annotated it is. Easy to forget and completely defeats the point.
            {"path": f"src/{self.package}/py.typed", "contents": ""},
        ]

    def _package_version(self) -> str:
        """A PEP 440 version for the generated distribution.

        An API version is not a package version. Stripe's is `2026-07-29.dahlia`, which no Python
        build backend will accept — `ruff` refused even to parse the `pyproject.toml`. Numeric,
        dot-separated leading components are kept when they form something valid; otherwise the
        package starts at `0.1.0` and the API version stays in the README where it belongs.
        """
        # The released SDK version wins when there is one: it is a package version by construction,
        # where the API's version is not (SPEC.md §3.5.1).
        released = self.options.get("sdkVersion")
        if isinstance(released, str) and released.strip():
            raw = released.strip()
        else:
            raw = str(self.ir["service"].get("version") or "").strip()
        parts = raw.lstrip("vV").split(".")
        numeric: list[str] = []
        for part in parts[:3]:
            if part.isdigit():
                numeric.append(str(int(part)))
            else:
                break
        if not numeric:
            return "0.1.0"
        while len(numeric) < 2:
            numeric.append("0")
        return ".".join(numeric)

    def _readme(self, distribution: str, env_var: str | None) -> str:
        example = self._first_example()
        env_note = (
            f"The client reads `{env_var}` from the environment when no credential is passed."
            if env_var
            else "This API declares no authentication."
        )
        return f"""# {self.client_name} Python SDK

```sh
pip install {distribution}
```

## Usage

```python
{example}
```

{env_note}

## Async

Every method exists on an async client too:

```python
import asyncio
from {self.package} import Async{self.client_name}


async def main() -> None:
    async with Async{self.client_name}() as client:
        ...


asyncio.run(main())
```

## Pagination

Paginated methods return a paginator. Iterating it walks every page:

```python
for item in client.{self._first_paginated() or "resource.list"}():
    print(item)
```

Use `.pages()` when you want one envelope at a time, including `total`.

## Errors

```python
from {self.package} import APIError, NotFoundError

try:
    ...
except NotFoundError as error:
    print(error.status, error.request_id)
except APIError as error:
    print(error.message)
```

Every exception this SDK raises subclasses `SDKError` (also exported as `{self.client_name}Error`).

## Retries and timeouts

Failed connections and 429/5xx responses are retried twice by default, with jittered exponential
backoff, honouring `Retry-After` when the server sends it. Override per client or per call:

```python
from {self.package} import RequestOptions

client.resource.method(options=RequestOptions(timeout=30.0, max_retries=0))
```

---

Generated by {self.brand["name"]}. `src/{self.package}/_core/` is a vendored runtime, so this
package has no dependency on the generator.
"""

    def _first_example(self) -> str:
        """A usage snippet built from a real operation in this spec, never invented."""
        for resource in self.all_resources:
            for method in resource.get("methods", []):
                if method["http"]["verb"] != "get" or method["http"].get("params"):
                    continue
                attr = safe_attribute(snake(resource["name"]["tokens"]))
                call = safe_method_name(snake(method["name"]["tokens"]))
                return (
                    f"from {self.package} import {self.client_name}\n\n"
                    f"client = {self.client_name}()\n"
                    f"result = client.{attr}.{call}()"
                )
        return f"from {self.package} import {self.client_name}\n\nclient = {self.client_name}()"

    def _first_paginated(self) -> str | None:
        for resource in self.all_resources:
            for method in resource.get("methods", []):
                if method.get("pagination") is not None:
                    return (
                        f"{safe_attribute(snake(resource['name']['tokens']))}"
                        f".{safe_method_name(snake(method['name']['tokens']))}"
                    )
        return None


#: Formats whose Python type is not `str`, and how to build one from a wire value.
#:
#: Mirrors `_STRING_FORMATS` in `types.py`, which decides the *annotation*; this decides the
#: *construction*. They are separate tables because one maps to a type name and the other to an
#: expression, and a `date` is built by `date.fromisoformat` while a `UUID` is built by its
#: constructor. Kept adjacent in intent: a format added there without a wrapper here produces an
#: example that does not typecheck, which the generated package's own gate reports.
_FORMAT_WRAPPERS: Mapping[str, tuple[str, str, str]] = {
    "date-time": ("datetime", "datetime", "datetime.fromisoformat"),
    "date": ("datetime", "date", "date.fromisoformat"),
    "uuid": ("uuid", "UUID", "UUID"),
    "decimal": ("decimal", "Decimal", "Decimal"),
}


#: A docstring delimiter, as a constant so the emitter never nests one in a literal.
QUOTES = '"""'


def _py_literal(value: object, indent: int = 0) -> str:
    """Render a JSON value from the IR as Python source.

    The values themselves are synthesized in the core, so this is only syntax — the whole division
    SPEC.md §3.11 sets up. A target that decided *what* the values were would be the sixth copy of
    one judgment.
    """
    pad = "    " * (indent + 1)
    close = "    " * indent
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return repr(value)
    if isinstance(value, list):
        if not value:
            return "[]"
        items = ",\n".join(f"{pad}{_py_literal(item, indent + 1)}" for item in value)
        return f"[\n{items},\n{close}]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        entries = ",\n".join(
            f"{pad}{key!r}: {_py_literal(item, indent + 1)}" for key, item in value.items()
        )
        return f"{{\n{entries},\n{close}}}"
    return "None"
