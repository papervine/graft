using Graft.Runtime;
using Xunit;

namespace Graft.Runtime.Tests;

public sealed class ValidateTests
{
  private static readonly Dictionary<string, Schema> NoTable = new();

  private static IReadOnlyList<string> Check(object? value, string descriptor) =>
      Validate.Check(value, Schema.Of(descriptor), NoTable);

  [Fact]
  public void AcceptsMatchingPrimitives()
  {
    Assert.Empty(Check("x", "{\"k\":\"str\"}"));
    Assert.Empty(Check(1L, "{\"k\":\"int\"}"));
    Assert.Empty(Check(1.5, "{\"k\":\"num\"}"));
    Assert.Empty(Check(true, "{\"k\":\"bool\"}"));
    Assert.Empty(Check(null, "{\"k\":\"null\",\"i\":{\"k\":\"str\"}}"));
  }

  [Fact]
  public void NamesTheFieldAndBothTypes()
  {
    var problems = Check(
        new Dictionary<string, object?> { ["id"] = 42L },
        "{\"k\":\"obj\",\"f\":[[\"id\",{\"k\":\"str\"},1]]}");
    Assert.Equal(new[] { "id should be a string but was an integer" }, problems);
  }

  [Fact]
  public void AcceptsAWholeDoubleWhereAnIntegerIsDeclared()
  {
    // A JSON integer arrives as 1.0 from serialisers with no integer type. Rejecting that would fail on data
    // that is actually correct.
    Assert.Empty(Check(1.0, "{\"k\":\"int\"}"));
    Assert.NotEmpty(Check(1.5, "{\"k\":\"int\"}"));
  }

  [Fact]
  public void ReportsAMissingRequiredFieldButNotAMissingOptionalOne()
  {
    const string schema = "{\"k\":\"obj\",\"f\":[[\"id\",{\"k\":\"str\"},1],[\"name\",{\"k\":\"str\"}]]}";
    Assert.Equal(
        new[] { "id is missing" },
        Check(new Dictionary<string, object?> { ["name"] = "x" }, schema));
    Assert.Empty(Check(new Dictionary<string, object?> { ["id"] = "x" }, schema));
  }

  [Fact]
  public void NeverComplainsAboutUnknownFields()
  {
    // A server adding a field must not break a client. That is the whole point of an evolving API.
    Assert.Empty(Check(
        new Dictionary<string, object?> { ["id"] = "x", ["brandNew"] = 123L },
        "{\"k\":\"obj\",\"f\":[[\"id\",{\"k\":\"str\"},1]]}"));
  }

  [Fact]
  public void TreatsAnEmptyArrayAsAValidEmptyMap()
  {
    // The PHP empty-map artifact: a PHP backend serialises `{}` as `[]`, and that is a valid empty map
    // rather than a wrong type.
    Assert.Empty(Check(new List<object?>(), "{\"k\":\"map\",\"v\":{\"k\":\"str\"}}"));
    Assert.Empty(Check(new List<object?>(), "{\"k\":\"obj\",\"f\":[]}"));
  }

  [Fact]
  public void WalksArraysAndReportsTheIndex()
  {
    var problems = Check(new List<object?> { "a", 2L }, "{\"k\":\"arr\",\"i\":{\"k\":\"str\"}}");
    Assert.Equal(new[] { "[1] should be a string but was an integer" }, problems);
  }

  [Fact]
  public void AcceptsAnyBranchOfAUnionAndReportsOnceWhenNoneMatch()
  {
    const string schema = "{\"k\":\"or\",\"o\":[{\"k\":\"str\"},{\"k\":\"int\"}]}";
    Assert.Empty(Check("x", schema));
    Assert.Empty(Check(3L, schema));
    // One message, not one per branch: a union of five reporting five problems buries the real one.
    Assert.Single(Check(true, schema));
  }

  [Fact]
  public void TerminatesOnASelfReferentialSchema()
  {
    // The cycle closes through the table rather than through recursion, so this is finite by construction
    // rather than by a depth cap.
    var table = Schema.Table("{\"Node\":{\"k\":\"obj\",\"f\":[[\"child\",{\"k\":\"ref\",\"n\":\"Node\"}]]}}");
    object value = new Dictionary<string, object?>
    {
      ["child"] = new Dictionary<string, object?>
      {
        ["child"] = new Dictionary<string, object?> { ["child"] = new Dictionary<string, object?>() },
      },
    };
    Assert.Empty(Validate.Check(value, Schema.Of("{\"k\":\"ref\",\"n\":\"Node\"}"), table));
  }

  [Fact]
  public void TreatsAMissingTableEntryAsAny()
  {
    // An incomplete table must not reject correct data.
    Assert.Empty(Validate.Check(
        new Dictionary<string, object?> { ["anything"] = 1L },
        Schema.Of("{\"k\":\"ref\",\"n\":\"Absent\"}"),
        NoTable));
  }

  [Fact]
  public void EnforceThrowsInStrictModeAndIsSilentWhenOff()
  {
    var schema = Schema.Of("{\"k\":\"obj\",\"f\":[[\"id\",{\"k\":\"str\"},1]]}");
    object value = new Dictionary<string, object?> { ["id"] = 1L };
    Validate.Enforce(value, schema, NoTable, "widgets.get", ValidationMode.Off);

    var error = Assert.Throws<ResponseValidationException>(
        () => Validate.Enforce(value, schema, NoTable, "widgets.get", ValidationMode.Strict));
    Assert.Contains("widgets.get", error.Message, StringComparison.Ordinal);
    Assert.Equal("widgets.get", error.Operation);
  }

  [Fact]
  public void AValidationFailureIsNotAnApiException()
  {
    // The server answered successfully; what failed is the contract between spec and implementation. A caller
    // catching ApiException to handle "the API said no" must not swallow this.
    Assert.False(typeof(ApiException).IsAssignableFrom(typeof(ResponseValidationException)));
    Assert.True(typeof(SdkException).IsAssignableFrom(typeof(ResponseValidationException)));
  }
}
