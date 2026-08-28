package core

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// Each test pins a decision from SPEC.md §3.4.1.1. The two things deliberately *not* checked matter
// most: getting those wrong would reintroduce the decode failures the open-enum and additive-field
// rules exist to prevent.

func testTable() SchemaTable {
	str := Schema{K: SchemaString}
	return SchemaTable{
		"Member": {K: SchemaObject, F: []SchemaField{
			{Name: "id", Schema: str, Required: true},
			{Name: "email", Schema: str, Required: true},
			{Name: "nickname", Schema: Schema{K: SchemaNull, I: &str}},
			{Name: "seats", Schema: Schema{K: SchemaInteger}},
		}},
		"Node": {K: SchemaObject, F: []SchemaField{
			{Name: "name", Schema: str, Required: true},
			{Name: "child", Schema: Schema{K: SchemaRef, N: "Node"}},
		}},
	}
}

func decode(t *testing.T, body string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(body), &value); err != nil {
		t.Fatalf("test fixture is not JSON: %v", err)
	}
	return value
}

var memberRef = Schema{K: SchemaRef, N: "Member"}

func TestValidateAcceptsAConformingObject(t *testing.T) {
	problems := Validate(decode(t, `{"id":"m1","email":"a@b.com"}`), memberRef, testTable())
	if len(problems) != 0 {
		t.Errorf("problems = %v", problems)
	}
}

func TestValidateReportsAnAbsentRequiredFieldByPath(t *testing.T) {
	problems := Validate(decode(t, `{"id":"m1"}`), memberRef, testTable())
	if len(problems) != 1 {
		t.Fatalf("problems = %v", problems)
	}
	if problems[0].Path != "email" || problems[0].Message != "is required but was absent" {
		t.Errorf("problem = %+v", problems[0])
	}
}

func TestValidateReportsTypeMismatchWithoutQuotingTheValue(t *testing.T) {
	// The value may be a secret — a token echoed back, a key in an error body — so the message
	// describes its shape and never its content.
	problems := Validate(decode(t, `{"id":12345,"email":"a@b.com"}`), memberRef, testTable())
	if len(problems) != 1 {
		t.Fatalf("problems = %v", problems)
	}
	if problems[0].Message != "should be a string but was an integer" {
		t.Errorf("message = %q", problems[0].Message)
	}
	if strings.Contains(problems[0].Message, "12345") {
		t.Error("the message leaked the value")
	}
}

func TestValidateDistinguishesIntegersFromNumbers(t *testing.T) {
	table := testTable()
	if problems := Validate(decode(t, `{"id":"m","email":"e","seats":3}`), memberRef, table); len(problems) != 0 {
		t.Errorf("an integer was rejected: %v", problems)
	}
	problems := Validate(decode(t, `{"id":"m","email":"e","seats":3.5}`), memberRef, table)
	if len(problems) != 1 || problems[0].Message != "should be an integer but was a number" {
		t.Errorf("problems = %v", problems)
	}
}

func TestValidateNullHandling(t *testing.T) {
	table := testTable()
	if problems := Validate(decode(t, `{"id":"m","email":"e","nickname":null}`), memberRef, table); len(problems) != 0 {
		t.Errorf("null in a nullable field was rejected: %v", problems)
	}
	problems := Validate(decode(t, `{"id":null,"email":"e"}`), memberRef, table)
	if len(problems) != 1 || problems[0].Message != "should be a string but was null" {
		t.Errorf("problems = %v", problems)
	}
}

func TestValidateIgnoresUnknownFields(t *testing.T) {
	// A server adding a field must never break a client. This is where that promise is kept.
	body := `{"id":"m1","email":"a@b.com","added_next_quarter":{"nested":true}}`
	if problems := Validate(decode(t, body), memberRef, testTable()); len(problems) != 0 {
		t.Errorf("an additive field was rejected: %v", problems)
	}
}

func TestValidateChecksEnumsAsTheirBaseTypeOnly(t *testing.T) {
	// The open-enum rule exists because servers add values without warning. Checking membership would
	// reintroduce exactly the decode failure that rule prevents.
	if problems := Validate("a_value_added_next_quarter", Schema{K: SchemaString}, nil); len(problems) != 0 {
		t.Errorf("an unrecognised enum value was rejected: %v", problems)
	}
}

func TestValidateReportsArrayIndexInThePath(t *testing.T) {
	schema := Schema{K: SchemaArray, I: &memberRef}
	problems := Validate(decode(t, `[{"id":"a","email":"e"},{"id":"b"}]`), schema, testTable())
	if len(problems) != 1 || problems[0].Path != "[1].email" {
		t.Errorf("problems = %v", problems)
	}
}

func TestValidateBracketsAKeyThatIsNotABareIdentifier(t *testing.T) {
	schema := Schema{K: SchemaMap, V: &Schema{K: SchemaInteger}}
	problems := Validate(decode(t, `{"weird-key":"x"}`), schema, nil)
	// Copy-pasteable as a path, which is what a path is for.
	if len(problems) != 1 || problems[0].Path != `["weird-key"]` {
		t.Errorf("problems = %v", problems)
	}
}

func TestValidateTerminatesOnARecursiveSchema(t *testing.T) {
	body := `{"name":"a","child":{"name":"b","child":{"name":"c"}}}`
	if problems := Validate(decode(t, body), Schema{K: SchemaRef, N: "Node"}, testTable()); len(problems) != 0 {
		t.Errorf("problems = %v", problems)
	}
}

func TestValidateAdditionalProperties(t *testing.T) {
	schema := Schema{
		K: SchemaObject,
		F: []SchemaField{{Name: "known", Schema: Schema{K: SchemaString}, Required: true}},
		A: &Schema{K: SchemaInteger},
	}
	if problems := Validate(decode(t, `{"known":"x","extra":1}`), schema, nil); len(problems) != 0 {
		t.Errorf("problems = %v", problems)
	}
	if problems := Validate(decode(t, `{"known":"x","extra":"no"}`), schema, nil); len(problems) != 1 {
		t.Errorf("problems = %v", problems)
	}
}

func TestValidateUnions(t *testing.T) {
	str := Schema{K: SchemaString}
	either := Schema{K: SchemaOr, O: []Schema{
		{K: SchemaObject, F: []SchemaField{
			{Name: "kind", Schema: str, Required: true},
			{Name: "a", Schema: Schema{K: SchemaInteger}, Required: true},
		}},
		{K: SchemaObject, F: []SchemaField{
			{Name: "kind", Schema: str, Required: true},
			{Name: "b", Schema: str, Required: true},
		}},
	}}
	if problems := Validate(decode(t, `{"kind":"x","a":1}`), either, nil); len(problems) != 0 {
		t.Errorf("first branch rejected: %v", problems)
	}
	if problems := Validate(decode(t, `{"kind":"x","b":"y"}`), either, nil); len(problems) != 0 {
		t.Errorf("second branch rejected: %v", problems)
	}
	// Only the closest branch is reported; listing every branch's complaints is noise.
	if problems := Validate(decode(t, `{"kind":"x"}`), either, nil); len(problems) != 1 {
		t.Errorf("problems = %v", problems)
	}
}

func TestValidateCapsTheNumberOfProblems(t *testing.T) {
	items := make([]any, 500)
	for i := range items {
		items[i] = float64(1)
	}
	problems := Validate(items, Schema{K: SchemaArray, I: &Schema{K: SchemaString}}, nil)
	// One broken contract, not five hundred.
	if len(problems) > maxProblems {
		t.Errorf("reported %d problems", len(problems))
	}
}

func TestValidateReportsADanglingReferenceAsAGeneratorBug(t *testing.T) {
	problems := Validate(map[string]any{}, Schema{K: SchemaRef, N: "Missing"}, nil)
	if len(problems) != 1 || !strings.Contains(problems[0].Message, "unknown schema") {
		t.Errorf("problems = %v", problems)
	}
}

func TestValidateAnyPassesAnything(t *testing.T) {
	body := decode(t, `{"whatever":[1,"two",null]}`)
	if problems := Validate(body, Schema{K: SchemaAny}, nil); len(problems) != 0 {
		t.Errorf("problems = %v", problems)
	}
}

func TestResponseValidationErrorIsNotAnAPIError(t *testing.T) {
	// The request succeeded and the contract was violated. Different problem, different type — a
	// caller handling a 4xx must not catch this by accident.
	var err error = &ResponseValidationError{
		Operation: "Orgs.ListMembers",
		Problems:  []ValidationProblem{{Path: "email", Message: "is required but was absent"}},
	}
	if _, ok := AsAPIError(err); ok {
		t.Error("a validation failure presented as an APIError")
	}
	var validation *ResponseValidationError
	if !errors.As(err, &validation) {
		t.Error("errors.As failed for the concrete type")
	}
	if !strings.Contains(err.Error(), "Orgs.ListMembers") {
		t.Errorf("the message does not name the operation: %q", err.Error())
	}
	// It is still an SDKError, so `errors.As(err, &sdkErr)` catches everything the SDK returns.
	var sdkErr SDKError
	if !errors.As(err, &sdkErr) {
		t.Error("a validation failure is not an SDKError")
	}
}

func TestErrorMessageTruncatesLongProblemLists(t *testing.T) {
	problems := make([]ValidationProblem, 10)
	for i := range problems {
		problems[i] = ValidationProblem{Path: "f", Message: "is required but was absent"}
	}
	message := (&ResponseValidationError{Operation: "op", Problems: problems}).Error()
	if !strings.Contains(message, "and 7 more") {
		t.Errorf("message = %q", message)
	}
}

func TestMustParseSchemaTable(t *testing.T) {
	table := MustParseSchemaTable(`{"Member":{"k":"obj","f":[{"n":"id","s":{"k":"str"},"r":true}]}}`)
	if problems := Validate(decode(t, `{"id":"x"}`), memberRef, table); len(problems) != 0 {
		t.Errorf("problems = %v", problems)
	}
	if problems := Validate(decode(t, `{}`), memberRef, table); len(problems) != 1 {
		t.Errorf("a round-tripped table lost its required flag: %v", problems)
	}
}
