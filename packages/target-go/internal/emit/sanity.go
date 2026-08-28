package emit

import "fmt"

// Sanity checks that decoding produced a usable IR.
//
// This exists because of a specific, expensive lesson from the Python target: reading `request` where
// the IR says `body` dropped every request body, and reading `pagination` where it says `paginationId`
// made every paginated method return one page. Both produced an SDK that compiled, linted,
// typechecked, and did not work. No gate over the *output* can catch that class of bug, because the
// output is well-formed — the bug is that it is well-formed and wrong.
//
// So the target asserts on its own input instead: if the IR describes operations with bodies, the
// decoded structs must have bodies. A JSON field this target names incorrectly decodes to its zero
// value silently, and this is what turns that silence into a loud failure.
//
// Deliberately structural, not semantic. It cannot know whether a body was rendered *correctly*; it
// can know that the IR said there were forty-one of them and the target saw zero.
func Sanity(ir *IR, raw map[string]any) []string {
	var problems []string

	rawResources, _ := raw["resources"].([]any)
	if len(rawResources) > 0 && len(ir.Resources) == 0 {
		problems = append(problems, fmt.Sprintf(
			"the IR has %d resources but none decoded — a renamed field in the resource struct?",
			len(rawResources)))
	}

	rawBodies, rawPaginated, rawMethods, rawParams := 0, 0, 0, 0
	var walkRaw func([]any)
	walkRaw = func(resources []any) {
		for _, entry := range resources {
			resource, _ := entry.(map[string]any)
			methods, _ := resource["methods"].([]any)
			for _, m := range methods {
				method, _ := m.(map[string]any)
				rawMethods++
				if _, ok := method["body"]; ok {
					rawBodies++
				}
				if _, ok := method["paginationId"]; ok {
					rawPaginated++
				}
				if http, ok := method["http"].(map[string]any); ok {
					if params, ok := http["params"].([]any); ok {
						rawParams += len(params)
					}
				}
			}
			if subs, ok := resource["subresources"].([]any); ok {
				walkRaw(subs)
			}
		}
	}
	walkRaw(rawResources)

	bodies, paginated, methods, params := 0, 0, 0, 0
	for _, resource := range ir.allResourcesValue() {
		for i := range resource.Methods {
			methods++
			if resource.Methods[i].Body != nil {
				bodies++
			}
			if resource.Methods[i].PaginationID != "" {
				paginated++
			}
			params += len(resource.Methods[i].HTTP.Params)
		}
	}

	check := func(label string, want, got int) {
		if want > 0 && got == 0 {
			problems = append(problems, fmt.Sprintf(
				"the IR has %d %s but none decoded — is the struct field name or json tag wrong?",
				want, label))
		}
	}
	check("methods", rawMethods, methods)
	check("request bodies", rawBodies, bodies)
	check("paginated operations", rawPaginated, paginated)
	check("parameters", rawParams, params)

	rawTypes, _ := raw["types"].([]any)
	if len(rawTypes) > 0 && len(ir.Types) == 0 {
		problems = append(problems, fmt.Sprintf("the IR has %d types but none decoded", len(rawTypes)))
	}

	return problems
}

// allResourcesValue flattens the resource tree. A method on IR so Sanity does not need an Emitter.
func (ir *IR) allResourcesValue() []*Resource {
	var flat []*Resource
	var walk func([]Resource)
	walk = func(resources []Resource) {
		for i := range resources {
			flat = append(flat, &resources[i])
			walk(resources[i].Subresources)
		}
	}
	walk(ir.Resources)
	return flat
}
