# Boundary Normalization

Archetype should not own every domain rule.

Your app still needs a thin normalization layer for semantics that must stay canonical when persisted.

The important part is to keep that layer thin, real, and honest.

## What Boundary Normalization Is For

Good uses:

- preserving domain semantics across edits
- canonicalizing stored values
- protecting merge behavior
- enforcing destructive invariants

Examples:

- a timed exercise stays timed when only the load changes
- `"30 sec"` and `"30s"` normalize to one stored representation
- clearing an affiliation becomes `null`, not `""`
- updates merge onto the existing entity instead of resetting unrelated fields

## What It Is Not For

Bad uses:

- compensating for a vague prompt
- silently correcting model intent when the contract itself is unclear
- trying to replace model judgment with rule spaghetti

If you are adding lots of repair code, first ask:

- is the action contract underspecified?
- are the examples weak?
- is the context missing the right IDs or labels?

## Recommended Order

1. improve the contract
2. improve the examples
3. improve the context
4. add thin normalization for app-owned invariants

That order matters.

## Common Patterns

### Preserve existing semantics on partial update

If the user changes weight only, do not erase duration, units, or relationship metadata.

Pattern:

```ts
const merged = { ...existing, ...partial }
```

Then normalize canonical fields from the merged result.

### Normalize nullable fields

If your product treats "empty" as "remove", normalize that once at the boundary.

Pattern:

```ts
principleId: raw === '' ? null : raw
```

### Canonicalize user-facing formats

If multiple string forms mean the same thing, store one canonical form.

Examples:

- `30 sec`, `30s`, `30 seconds`
- weight units
- date formats
- range representations

### Rebuild derived fields only when needed

If an entity has derived state, do not blindly rebuild it every time.

Good:

- rebuild only when structural fields changed
- preserve user-entered progress where possible

## Product Case Studies

### A fitness coaching app

Normalization belongs in the app because workout semantics are real:

- timed holds
- durations
- unilateral behavior
- set rebuilding

This should not move into Archetype core.

### A CEO coaching app

Normalization is useful for compatibility:

- direct-field updates and legacy `field/value` can both map to one internal update shape

That is a product migration concern, not a core SDK concern.

### A nutrition guide

The boundary concern is history truthfulness:

- store only executed actions
- do not annotate assistant history with actions that never happened

## Smell Test

Your normalization layer is probably too heavy if:

- it changes product intent rather than preserving it
- it duplicates prompt logic
- the model could not understand what happened by reading the action contract
- new contributors need to reverse-engineer hidden rewrite rules

The best normalization layers are boring.
