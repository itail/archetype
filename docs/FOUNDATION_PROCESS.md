# Foundation Process

This document exists to stop prompt cleanup from turning into repeated fleet-wide migrations.

The rule is simple:

- Do not propagate while still discovering first-order foundation problems.
- Do not reopen or rewrite locked invariants without explicit human approval.

Archetype must pass a small number of explicit milestones before reference apps or production apps are updated. If a later milestone discovers a new Archetype-level problem, stop, fix Archetype, and restart from the keystone review stage.

## Goal

Archetype should be a rock-solid foundation:

- smallest prompt that still performs cleanly
- no duplicate teaching
- no prompt boxing
- no patch-language
- no instruction theater
- clean separation between chat, proactive chat, and operational turn
- one shared request path
- minimal app prose outside real world/domain semantics

## Non-Negotiable Rules

0. Locked invariants require explicit approval to reopen.

If a trace, reviewer, benchmark, or implementation failure appears to contradict
a locked invariant, the coding agent must stop and ask the human owner before
changing the invariant doc, invariant tests, action schemas, prompt surfaces,
default tool surfaces, or downstream consumers.

The required ask is concrete:

- name the invariant,
- show the contradicting evidence,
- state the proposed replacement,
- wait for explicit approval.

Evidence can justify the request. Evidence is not permission.

1. Archetype owns generic prompt philosophy.

Apps may define:

- world model
- domain semantics
- visible objects and IDs
- route-local scene guidance

Apps may not redefine by default:

- generic conversational stance
- generic app-initiated turn behavior
- generic continuity rules
- generic momentum / come-back heuristics
- generic output transport guidance
- generic anti-boxing guidance

2. No fleet rollout while reviewers are still finding foundational issues.

Examples:

- duplicate identity framing
- duplicate keystone / come-back framing
- wrong cross-domain examples
- unclear turn type
- prompt accretion
- missing canonical IDs on mutable objects

3. Prompt review uses exact provider-boundary requests, not hand-assembled approximations.

Use:

- `buildChatLLMRequest(config, input)`
- `buildPromptedTurnLLMRequest(config, input)`

4. Prompt changes require baseline comparison before propagation.

Shorter is only better if behavior is at least as good.

## Milestones

### Milestone 1: Archetype Keystone Pass

Scope:

- Archetype only
- no app migrations yet

Required artifacts:

- exact chat prompt
- exact proactive-conversation prompt
- exact operational prompt
- checked-in golden prompt fixtures under `tests/__fixtures__/golden-prompts/`

Required checks:

- internal review
- external review from at least two strong reviewers
- exact prompt diff versus previous version
- baseline eval comparison on representative scenarios
- targeted tests green

Suggested command path:

- `npm run golden:update`
- `npm test -- tests/golden-prompt-surfaces.test.ts tests/prompt-content-audit.test.ts`

Exit condition:

- no major structural issues
- no repeated foundational findings
- only minor wording or app-local feedback remains

If reviewers still find first-order issues, stay here.

### Milestone 2: Reference Proof

Scope:

- one reference app only

Goal:

- prove Archetype survives contact with a real app without app scar tissue compensating for core weakness

Required checks:

- exact prompt review for the app's real routes
- exact prompt artifacts checked in for the app's real routes
- fresh-review subagent pass against the same review bundle
- external review from at least one independent reviewer
- clean trace behavior
- eval honesty: judges must be able to see real CRUD/state deltas, not just narrative text
- correct turn classification
- no new Archetype-level findings
- no ontology mismatch between surfaced context and CRUD-manipulable schema
- no app directives that simply restate identity or north star
- rerun Archetype golden prompts and every already-locked reference app after any shared-layer fix discovered during this stage

Exit condition:

- remaining feedback is mostly app-local

If a new Archetype-level issue is found, stop and return to Milestone 1.

### Milestone 3: Contrast Proof

Scope:

- one strongly contrasting app

Goal:

- prove the foundation generalizes beyond one surface

Required checks:

- same standards as Milestone 2

Exit condition:

- no repeated core findings across both apps

If the second app uncovers a core prompt issue, stop and return to Milestone 1.

## Reference-App Rules

Reference apps are not just examples. They teach future coding agents what belongs in the app layer.

That means:

- every load-bearing concept in the app's world model must have a real surface if the model is expected to track or change it
- every field shown in live structured context should exist on the entity schema if the model may need to update it
- app directives should express local in-the-room standards or route posture, not restate identity, north star, or generic Archetype stance
- cross-entity relationships should be visible in context with canonical IDs when they matter for CRUD integrity
- if a review finding appears to come from generic memory/reality/contract wording, fix Archetype first instead of trimming the app

## Mandatory Lessons From Reference App 1

The first reference app surfaced a few rules that should now be treated as mandatory:

- keep the Archetype memory block to compact contextual framing, not SDK self-explanation
- align app world model claims with actual entity/context surface; do not teach a concept the app cannot represent
- sharpen durable app-specific notes so they do not overlap semantically with Archetype memory
- audit for context/schema mismatch: if context shows `owner`, `description`, or other persistent fields, either include them in schema or stop surfacing them as mutable facts
- prefer directives that help the expert choose inside the room over directives that merely repeat the app's mission

## Mandatory Lessons From Contrast Proof

The second reference app surfaced another set of rules that now become part of the gate:

- if a shared SDK surface still feels domain-flavored in the wrong app, fix Archetype instead of teaching around it locally
- default memory categories should be persona-neutral unless the app explicitly overrides them with domain categories
- optional-heavy entity examples should model sparse, situation-driven creates instead of silently teaching "fill every field"
- after any Archetype-level fix discovered during reference review, rerun:
  - Archetype golden prompts
  - the current reference app
  - every previously locked reference app
- a contrast-proof reference app does not need a maximal ontology; it does need an honest one
- eval summaries must expose meaningful state changes; if a due date or ownership change matters, the eval summary should show it

## Mandatory Lessons From First Product Rollout

The first real product rollout added another class of lessons. These are not reference-app polish; they are rollout discipline.

- run live/Turing gates on a representative production-capable provider before diagnosing prompt quality; do not let a weaker local stand-in muddy the root cause
- if a product vendors Archetype, refresh the vendored runtime before diagnosing app-layer prompt quality; otherwise reviews are judging stale keystone behavior
- when a live failure disappears on the representative provider, treat the remaining issue as behavioral or evaluative, not transport, and stop "simplifying for the poor model"
- do not assume a rich entity surface is the problem just because a reviewer says "too complex"; first check whether the route is semantically honest and whether the behavior holds on the right provider
- ordinary chat and proactive routes should carry only the entities and procedures that genuinely belong to those routes; debrief/preflight-only ontology and procedural guidance must stay route-local
- if prior notes, cues, and memories stack toward a direct intervention, treat that as scenario pressure that may be correct, not automatically a prompt bug
- when judging a coaching turn, distinguish "too direct for the desired coaching style" from "structurally wrong prompt"; the fix may belong in scenario design or eval expectations rather than in more prompt boxing
- review bundles for live failures should include the actual prompt, the actual failing response, and the concrete diagnostic question so internal and external reviewers are looking at the same evidence
- after a shared rollout lesson is discovered, propagate only the universal part across already-tested projects; do not spray local world-model decisions across the fleet
- if a product keeps a separate eval persona or mini-fixture, audit it against the real app config before trusting live failures; eval drift can masquerade as prompt regressions
- when an app has hidden mutations, teach one clean truthfulness rule explicitly: do not claim something was handled unless the corresponding action is actually in the response; speak in user-facing outcomes, not internal tool mechanics

### Milestone 4: Rollout

Only after Milestones 1-3 pass:

1. Archetype reference apps
2. first-party proving apps
3. broader Archetype consumers

Never skip directly from Archetype edits to full-fleet propagation.

## Hard Stop Rule

If a reviewer or eval finds a foundational issue during Reference Proof or Contrast Proof:

1. stop rollout
2. fix Archetype
3. regenerate exact prompt artifacts
4. rerun baseline comparison
5. resume from Milestone 1

No "we'll clean it up as we migrate."

## Review Standard

The bar is not "zero criticism."

The bar is:

- no foundational contradictions
- no repeated major findings from multiple reviewers
- no obvious duplication, boxing, or ontology drift
- no app prose compensating for missing Archetype behavior

If feedback is mostly taste or minor wording preference, move on.

If feedback is about structure, role confusion, duplicated teaching, or wrong examples, the milestone fails.

## Required Review Questions

Every keystone review should answer:

1. What lines are truly load-bearing?
2. What is duplicated?
3. What is boxing?
4. What is patch-language?
5. What is instruction theater?
6. What belongs in code/contract instead of prose?
7. What belongs in Archetype versus the app?
8. Are mutable objects exposed with canonical IDs?
9. Do the three turn types feel clearly distinct while sharing one code path?

## Release Gate

Archetype is ready to propagate only when all are true:

- exact prompt audits pass
- golden prompt snapshots are approved
- baseline evals are neutral or better
- reference proof passes
- contrast proof passes
- no unresolved Archetype-level review findings remain
