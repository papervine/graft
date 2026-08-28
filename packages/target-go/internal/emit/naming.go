package emit

import (
	"strings"
	"unicode"
)

// Initialisms Go capitalises wholly. This is the list golint used, and it is why the IR stores names
// as lowercase tokens: `pascal(["user","id"])` gives `UserId`, which is *wrong* in Go and correct in
// TypeScript. No amount of pre-casing in the core could serve both.
var initialisms = map[string]string{
	"acl": "ACL", "api": "API", "ascii": "ASCII", "cpu": "CPU", "css": "CSS",
	"dns": "DNS", "eof": "EOF", "guid": "GUID", "html": "HTML", "http": "HTTP",
	"https": "HTTPS", "id": "ID", "ip": "IP", "json": "JSON", "lhs": "LHS",
	"qps": "QPS", "ram": "RAM", "rhs": "RHS", "rpc": "RPC", "sla": "SLA",
	"smtp": "SMTP", "sql": "SQL", "ssh": "SSH", "tcp": "TCP", "tls": "TLS",
	"ttl": "TTL", "udp": "UDP", "ui": "UI", "uid": "UID", "uuid": "UUID",
	"uri": "URI", "url": "URL", "utf8": "UTF8", "vm": "VM", "xml": "XML",
	"xmpp": "XMPP", "xsrf": "XSRF", "xss": "XSS",
}

// reservedWords are Go keywords. A generated identifier that collides with one does not compile.
var reservedWords = map[string]bool{
	"break": true, "case": true, "chan": true, "const": true, "continue": true,
	"default": true, "defer": true, "else": true, "fallthrough": true, "for": true,
	"func": true, "go": true, "goto": true, "if": true, "import": true,
	"interface": true, "map": true, "package": true, "range": true, "return": true,
	"select": true, "struct": true, "switch": true, "type": true, "var": true,
}

// predeclared are Go's predeclared identifiers. Unlike keywords these are only *shadowed*, not a
// syntax error — but a generated type named `error` or `string` makes the surrounding code
// incomprehensible, so exported names avoid them.
var predeclared = map[string]bool{
	"any": true, "bool": true, "byte": true, "comparable": true, "complex64": true,
	"complex128": true, "error": true, "float32": true, "float64": true, "int": true,
	"int8": true, "int16": true, "int32": true, "int64": true, "rune": true,
	"string": true, "uint": true, "uint8": true, "uint16": true, "uint32": true,
	"uint64": true, "uintptr": true, "true": true, "false": true, "iota": true,
	"nil": true, "append": true, "cap": true, "clear": true, "close": true,
	"complex": true, "copy": true, "delete": true, "imag": true, "len": true,
	"make": true, "max": true, "min": true, "new": true, "panic": true,
	"print": true, "println": true, "real": true, "recover": true,
}

// Exported renders tokens as an exported Go identifier, honouring initialisms.
//
//	["user", "id"]      → UserID
//	["api", "key"]      → APIKey
//	["display", "name"] → DisplayName
func Exported(name Name) string {
	return joinTokens(name.Tokens, true)
}

// Unexported renders tokens as an unexported Go identifier.
//
// The first token stays lowercase even when it is an initialism — `apiKey`, not `aPIKey` — which is
// what gofmt-adjacent tooling and every Go codebase does.
func Unexported(name Name) string {
	if len(name.Tokens) == 0 {
		return "value"
	}
	out := strings.ToLower(name.Tokens[0])
	if len(name.Tokens) > 1 {
		out += joinTokens(name.Tokens[1:], true)
	}
	if reservedWords[out] || predeclared[out] {
		return out + "_"
	}
	return out
}

func joinTokens(tokens []string, exported bool) string {
	var b strings.Builder
	for _, token := range tokens {
		if token == "" {
			continue
		}
		lower := strings.ToLower(token)
		if replacement, ok := initialisms[lower]; ok {
			b.WriteString(replacement)
			continue
		}
		runes := []rune(lower)
		if exported {
			runes[0] = unicode.ToUpper(runes[0])
		}
		b.WriteString(string(runes))
	}
	result := b.String()
	if result == "" {
		return "Value"
	}
	// A leading digit is not a valid identifier. Twilio's date-based groups reach here.
	if unicode.IsDigit([]rune(result)[0]) {
		result = "N" + result
	}
	return result
}

// FieldName renders a struct field name.
//
// Go has no shadowing hazard for a struct field — `w.Type` cannot collide with the `type` keyword,
// because it is only ever reached through a selector. So unlike locals, a field keeps its natural
// name whatever it is called on the wire.
func FieldName(name Name) string {
	return Exported(name)
}

// LocalName renders a local variable or parameter name, avoiding keywords and predeclared
// identifiers.
//
// Stricter than FieldName because a bare `type` is a syntax error and a bare `len` shadows the
// builtin for the rest of the function — and generated method bodies call `len`.
func LocalName(name Name) string {
	return Unexported(name)
}

// TypeName renders a type name, avoiding collisions with what the file already declares.
//
// Suffixed with `Model` rather than a digit for the same reason the other targets prefer it: one
// reads as deliberate, the other as the generator giving up.
func TypeName(name Name, taken map[string]bool) string {
	base := Exported(name)
	if predeclared[base] || reservedWords[base] {
		base += "Model"
	}
	if !taken[base] {
		return base
	}
	if candidate := base + "Model"; !taken[candidate] {
		return candidate
	}
	for i := 2; ; i++ {
		candidate := base + "Model" + itoa(i)
		if !taken[candidate] {
			return candidate
		}
	}
}

// UniqueField returns a field name not already used in the same struct.
//
// Two wire names can render to the same Go identifier — `user_id` and `userId` both give `UserID` —
// and a duplicate struct field does not compile. The wire name survives on the json tag, so
// disambiguating the Go name costs a caller nothing.
func UniqueField(name Name, taken map[string]bool) string {
	base := FieldName(name)
	if !taken[base] {
		taken[base] = true
		return base
	}
	for i := 2; ; i++ {
		candidate := base + itoa(i)
		if !taken[candidate] {
			taken[candidate] = true
			return candidate
		}
	}
}

// FileName renders a resource id as a Go file name: lowercase, underscore-separated.
func FileName(resourceID string) string {
	var b strings.Builder
	for i, r := range resourceID {
		switch {
		case r == '.' || r == '-' || r == ' ' || r == '/':
			b.WriteRune('_')
		case unicode.IsUpper(r):
			// A boundary is a lower/digit followed by an upper, or the end of a capital run.
			if i > 0 {
				prev := rune(resourceID[i-1])
				var next rune
				if i+1 < len(resourceID) {
					next = rune(resourceID[i+1])
				}
				if unicode.IsLower(prev) || unicode.IsDigit(prev) ||
					(unicode.IsUpper(prev) && unicode.IsLower(next)) {
					b.WriteRune('_')
				}
			}
			b.WriteRune(unicode.ToLower(r))
		default:
			b.WriteRune(unicode.ToLower(r))
		}
	}
	name := strings.Trim(b.String(), "_")
	for strings.Contains(name, "__") {
		name = strings.ReplaceAll(name, "__", "_")
	}
	if name == "" {
		return "resource"
	}
	return name
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

// exportedValue turns an enum member into an exported identifier suffix: `us-east-1` → `USEast1`.
//
// Separators split, and a leading digit is kept attached to the token before it — `us-east-1` reads
// better as `USEast1` than `USEast_1`, and Go has no convention that would prefer the latter.
func exportedValue(value string) string {
	tokens := strings.FieldsFunc(value, func(r rune) bool {
		return r == '-' || r == '_' || r == '.' || r == ' ' || r == '/'
	})
	if len(tokens) == 0 {
		return "Empty"
	}
	return joinTokens(tokens, true)
}
