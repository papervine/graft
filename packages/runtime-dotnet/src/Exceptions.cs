namespace Graft.Runtime;

/// <summary>
/// The base of every error this runtime raises.
/// </summary>
/// <remarks>
/// <para>
/// Named for its role, never for the generator. A generator-branded class would put this tool's name in every
/// consumer's catch block, making a rename here a breaking change for every SDK ever produced
/// (SPEC.md §1.2). Generated code aliases this to <c>&lt;ClientName&gt;Exception</c>.
/// </para>
/// <para>
/// C# has no checked exceptions, so the debate the Java target had to settle does not arise here.
/// </para>
/// </remarks>
public abstract class SdkException : Exception
{
  protected SdkException(string message)
      : base(message)
  {
  }

  protected SdkException(string message, Exception inner)
      : base(message, inner)
  {
  }
}

/// <summary>The response arrived but was not the JSON it claimed to be.</summary>
public sealed class DecodeException : SdkException
{
  public DecodeException(string message)
      : base(message)
  {
  }

  public DecodeException(string message, Exception inner)
      : base(message, inner)
  {
  }
}

/// <summary>
/// The server responded, and said no.
/// </summary>
/// <remarks>
/// Always carries a status. Connection failures live on their own branch precisely so that stays true —
/// otherwise every caller reading <see cref="StatusCode"/> would need a check for a case that never has one.
/// </remarks>
public class ApiException : SdkException
{
  public ApiException(
      int statusCode,
      string message,
      string? requestId = null,
      object? body = null,
      IReadOnlyDictionary<string, string>? headers = null)
      : base(message)
  {
    StatusCode = statusCode;
    RequestId = requestId;
    Body = body;
    Headers = headers ?? new Dictionary<string, string>();
  }

  public int StatusCode { get; }

  /// <summary>The server's request id, when it sent one. Null otherwise — the caller cannot invent it.</summary>
  public string? RequestId { get; }

  /// <summary>The decoded error body, as a tree. Null when the response had none.</summary>
  public object? Body { get; }

  public IReadOnlyDictionary<string, string> Headers { get; }
}

/// <inheritdoc/>
public sealed class BadRequestException : ApiException
{
  public BadRequestException(int statusCode, string message, string? requestId = null, object? body = null, IReadOnlyDictionary<string, string>? headers = null)
      : base(statusCode, message, requestId, body, headers)
  {
  }
}

/// <inheritdoc/>
public sealed class AuthenticationException : ApiException
{
  public AuthenticationException(int statusCode, string message, string? requestId = null, object? body = null, IReadOnlyDictionary<string, string>? headers = null)
      : base(statusCode, message, requestId, body, headers)
  {
  }
}

/// <inheritdoc/>
public sealed class PermissionDeniedException : ApiException
{
  public PermissionDeniedException(int statusCode, string message, string? requestId = null, object? body = null, IReadOnlyDictionary<string, string>? headers = null)
      : base(statusCode, message, requestId, body, headers)
  {
  }
}

/// <inheritdoc/>
public sealed class NotFoundException : ApiException
{
  public NotFoundException(int statusCode, string message, string? requestId = null, object? body = null, IReadOnlyDictionary<string, string>? headers = null)
      : base(statusCode, message, requestId, body, headers)
  {
  }
}

/// <inheritdoc/>
public sealed class ConflictException : ApiException
{
  public ConflictException(int statusCode, string message, string? requestId = null, object? body = null, IReadOnlyDictionary<string, string>? headers = null)
      : base(statusCode, message, requestId, body, headers)
  {
  }
}

/// <inheritdoc/>
public sealed class UnprocessableEntityException : ApiException
{
  public UnprocessableEntityException(int statusCode, string message, string? requestId = null, object? body = null, IReadOnlyDictionary<string, string>? headers = null)
      : base(statusCode, message, requestId, body, headers)
  {
  }
}

/// <inheritdoc/>
public sealed class InternalServerException : ApiException
{
  public InternalServerException(int statusCode, string message, string? requestId = null, object? body = null, IReadOnlyDictionary<string, string>? headers = null)
      : base(statusCode, message, requestId, body, headers)
  {
  }
}

/// <summary>A 429. Carries <see cref="RetryAfter"/> when the server said how long to wait.</summary>
public sealed class RateLimitException : ApiException
{
  public RateLimitException(
      int statusCode,
      string message,
      string? requestId = null,
      object? body = null,
      IReadOnlyDictionary<string, string>? headers = null,
      TimeSpan? retryAfter = null)
      : base(statusCode, message, requestId, body, headers)
  {
    RetryAfter = retryAfter;
  }

  /// <summary>How long the server asked us to wait, or null when it did not say.</summary>
  public TimeSpan? RetryAfter { get; }
}

/// <summary>The request never completed: DNS, TLS, connection reset. No status, because none arrived.</summary>
public class ConnectionException : SdkException
{
  public ConnectionException(string message)
      : base(message)
  {
  }

  public ConnectionException(string message, Exception inner)
      : base(message, inner)
  {
  }
}

/// <summary>
/// The request exceeded its timeout.
/// </summary>
/// <remarks>
/// Distinguished from <see cref="ConnectionException"/> because a timeout is retryable in a way a TLS failure
/// is not.
/// </remarks>
public sealed class TimeoutException : ConnectionException
{
  public TimeoutException(string message, Exception inner)
      : base(message, inner)
  {
  }
}

/// <summary>
/// A response did not match the shape the spec declared.
/// </summary>
/// <remarks>
/// Deliberately <b>not</b> an <see cref="ApiException"/>. The server answered successfully; what failed is the
/// contract between the spec and the implementation, and a caller catching <c>ApiException</c> to handle
/// <i>the API saying no</i> should not accidentally swallow this (SPEC.md §3.4.1.1).
/// </remarks>
public sealed class ResponseValidationException : SdkException
{
  public ResponseValidationException(string operation, IReadOnlyList<string> problems)
      : base(BuildMessage(operation, problems))
  {
    Operation = operation;
    Problems = problems;
  }

  public string Operation { get; }

  public IReadOnlyList<string> Problems { get; }

  private static string BuildMessage(string operation, IReadOnlyList<string> problems)
  {
    var first = problems.Count == 0 ? "the response did not match the declared shape" : problems[0];
    var extra = problems.Count > 1 ? $" (and {problems.Count - 1} more)" : string.Empty;
    return $"{operation}: the response did not match the API's declared shape — {first}{extra}";
  }
}

/// <summary>Obtaining or refreshing an OAuth2 token failed.</summary>
public sealed class OAuth2Exception : SdkException
{
  public OAuth2Exception(string message)
      : base(message)
  {
  }
}
