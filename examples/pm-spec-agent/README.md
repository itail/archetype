# PM Spec Agent Sample

This sample shows a non-coding focus-mode agent using the same Archetype
primitives as the coding agent:

- a full `WORK ITEM` that stays in context
- chronological `WORK HISTORY` for self-notes, action outcomes, and world changes
- factual `FILES` context with size signals
- file actions whose next turn sees outcomes, not raw action payloads
- prompt trace dumps for every turn

It is intentionally small. The point is not to create a special PM product;
the point is to prove the reusable Archetype contract for focused, multi-turn
tool work.

Run the audit:

```bash
node examples/pm-spec-agent/audit.mjs
```

Run a live sample:

```bash
GEMINI_API_KEY=... node examples/pm-spec-agent/index.mjs
```

The live sample prints the temporary workspace and prompt-trace directory when
it finishes.
