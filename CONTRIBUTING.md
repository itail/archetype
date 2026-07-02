# Contributing

Thanks for your interest! Archetype is young in public — issues and discussions are the most valuable contribution right now.

- **Bugs / questions**: open a GitHub issue with a minimal reproduction.
- **Development**: `npm install && npm test` — the full suite (660+ tests) runs offline in seconds, no API key needed. Live evals (`npm run test:live`) require `GEMINI_API_KEY`.
- **Prompt changes**: any change to prompt-building code must keep the golden prompt-surface tests green (`tests/golden-prompt-surfaces.test.ts`); regenerate fixtures deliberately with `npm run golden:update` and include the diff in your PR.
- **Design principles**: read `PLAYBOOK_ESSENTIALS.md` first — especially scenario-first vs. prescriptive prompting. PRs that add behavioral rules where a thinking nudge belongs will be asked to rework.
- **Locked invariants**: `docs/ARCHETYPE_LOCKED_CONTINUITY_INVARIANTS_2026-04-28.md` documents design conclusions enforced by tests; reopening one requires explicit maintainer approval.
