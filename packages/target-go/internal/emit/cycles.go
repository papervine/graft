package emit

// valueCycle decides which struct fields must be pointers to keep the type finite.
//
// This is the first requirement no other target has. TypeScript and Python reference objects, so a
// self-referential type is free; Go embeds a struct *by value*, so `type A struct { B B }` where B
// contains an A is an infinitely-sized type and a compile error — Stripe's
// `PersonAdditionalTosAcceptance` is one.
//
// The IR does carry a `cyclic` flag per type, but it is not enough: it says *this type participates in
// a cycle*, not *this field closes one*. Pointer-ising every field of a cyclic type would be wrong in
// the other direction, turning required scalars into pointers a caller must dereference for no
// reason. So the edge is computed here, where the value/reference distinction lives.
//
// A slice, map, or pointer field already breaks a cycle, so only direct named-struct fields are
// considered edges.
type valueCycle struct {
	mapper *TypeMapper
	// edges[id] is the set of type ids that id contains by value.
	edges map[string]map[string]bool
	// reaches memoizes "can id reach target through value edges".
	reaches map[string]map[string]bool
}

func newValueCycle(ir *IR, mapper *TypeMapper) *valueCycle {
	vc := &valueCycle{
		mapper:  mapper,
		edges:   map[string]map[string]bool{},
		reaches: map[string]map[string]bool{},
	}
	for i := range ir.Types {
		named := &ir.Types[i]
		if named.Kind != "object" {
			continue
		}
		set := map[string]bool{}
		for j := range named.Fields {
			field := &named.Fields[j]
			// Only a required, directly-named field is a value edge. An optional one is already a
			// pointer, and an array or map field is already indirect.
			if !field.Required {
				continue
			}
			if id := valueEdgeTarget(&field.Type); id != "" {
				set[id] = true
			}
		}
		vc.edges[named.ID] = set
	}
	return vc
}

// valueEdgeTarget returns the type id a reference embeds by value, or "" when it does not embed one.
func valueEdgeTarget(ref *TypeRef) string {
	if ref == nil {
		return ""
	}
	switch ref.Kind {
	case "named":
		return ref.ID
	case "nullable":
		// Rendered as a pointer, so it breaks the cycle — unless the inner type is itself already
		// nilable, in which case the reference is still indirect.
		return ""
	}
	return ""
}

// MustPointer reports whether a field must be a pointer to keep `owner` finite.
func (vc *valueCycle) MustPointer(owner string, field *Field) bool {
	if !field.Required {
		return false
	}
	target := valueEdgeTarget(&field.Type)
	if target == "" {
		return false
	}
	// A struct containing itself, directly or through a chain of value fields.
	return target == owner || vc.canReach(target, owner)
}

func (vc *valueCycle) canReach(from, target string) bool {
	if cached, ok := vc.reaches[from]; ok {
		if result, ok := cached[target]; ok {
			return result
		}
	}
	visiting := map[string]bool{}
	result := vc.walk(from, target, visiting)
	if vc.reaches[from] == nil {
		vc.reaches[from] = map[string]bool{}
	}
	vc.reaches[from][target] = result
	return result
}

func (vc *valueCycle) walk(from, target string, visiting map[string]bool) bool {
	if from == target {
		return true
	}
	if visiting[from] {
		return false
	}
	visiting[from] = true
	for next := range vc.edges[from] {
		if vc.walk(next, target, visiting) {
			return true
		}
	}
	return false
}
