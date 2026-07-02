# Archetype Evals

Archetype now ships with a reusable evaluation harness built to stress-test both the SDK and the persona concept.

## Why This Exists

The goal is not just "does the SDK parse JSON and emit actions."

The real bar is:

- Does the persona read like a human in the right relationship?
- Does it move the user toward the north star?
- Do actions happen invisibly and cleanly?
- Does memory compound the experience instead of making it clanky?
- Does the concept itself hold up across different domains?

## The Five Failure Surfaces

The sample projects are intentionally chosen to stress different weak spots:

1. Executive coach
   Tests abstract reasoning, low-action default behavior, and pattern naming.

2. Nutrition guide
   Tests invisible logging, update-vs-duplicate behavior, warmth, and soft memory.

3. Strength coach
   Tests structured actions, hard constraints, and whether the coach still feels human.

4. Language tutor
   Tests conversational fluency, correction style, learner memory, and natural practice design.

5. Chief of staff
   Tests CRUD-heavy operations, quiet task hygiene, and operational sharpness without bureaucracy.

## What We Learned Building Real Personas

These were the highest-signal upgrades from writing and evaluating real-world personas:

- Mutability must be designed in up front.
  If a persona will update threads, tasks, mistakes, or memories, IDs must already be visible in context.

- Invisible operations need explicit help.
  "Don't narrate what you're doing" is not enough. The prompt and history model both need to reinforce quiet action behavior.

- Update/delete hygiene matters as much as create.
  Clanky personas often come from duplication, not from missing features. The SDK should make "update in place" a first-class pattern.

- Follow-ups are part of the product, not garnish.
  Weak follow-ups make the persona feel flatter and less human, even if the main response is decent.

- Memory needs both extraction and maintenance.
  Saving memories is not enough. Good personas also revise or remove stale facts.

- Relationship fit is domain-specific.
  Warm companion works for nutrition. It hurts in domains that want sharpness or authority. The persona archetype has to match the trust model.

- Prompts should be written from intent, not fear.
  The most brittle lines were the ones trying to stop weak-model behavior with scolding or disclaimers. Better personas came from describing the situation and trusting the model's judgment.

- Overfitted fixes can pass a test while shrinking the persona.
  If a prompt change starts sounding like "when the user says X, do Y," pause. A better fix is often to improve the persona's north star, keystone, or action semantics so the model can infer the right move from the scenario.

- Small wording choices can create big behavioral gravity.
  We saw this with the chief-of-staff keystone: wording that subtly rewarded "create the next move" nudged the model toward task capture. Reframing it around reducing friction and creating leverage preserved agency while still passing the triage stress test.

- Better contracts beat defensive repair.
  When an app starts accumulating "fix the model output" code, first ask whether the action surface, examples, or context are underspecified. Stronger contracts usually age better than clever cleanup.

- Thin boundary normalization is still worth it.
  Some semantics are app-owned even with strong models: units, durations, ranges, merge behavior, ID integrity, and persistence invariants. The best pattern is a thin normalization layer that preserves meaning without trying to replace model judgment.

- Working-set personas need different failure checks than proposal-tray personas.
  The important questions are:
  - did accepted meaning-layer changes become the current draft?
  - did newer deltas supersede older active ones cleanly?
  - did the assistant avoid claiming transport execution before commit?
  - did the app end up with duplicate drafts because `targetKey` was missing or wrong?

## Current Harness

### Deterministic evals

`tests/evals.test.ts`

These use scripted providers and real side-effect handlers against in-memory state. They verify:

- actions are emitted when expected
- updates happen instead of duplicates
- proposed actions stay out of stored history
- accepted working-set deltas persist across turns
- transport deltas stay `ready` until committed
- supersession works via `targetKey`
- memories persist correctly
- prompt context includes the right IDs and critical state

### Live Turing evals

`tests/turing.test.ts`

These are optional and require `GEMINI_API_KEY`.

Run:

```bash
npm run test:live
```

They currently test:

- scenario execution with real Gemini calls
- judge-based scoring for human voice, relationship fit, judgment, invisible operations, memory hygiene, specificity, and goal advancement
- multi-turn conversation scoring across the full transcript
- pairwise comparison between the full persona and a deliberately degraded baseline
- hallucinated execution failures, where the assistant talks as if a transport action already happened when it was only staged

Working-set-specific failure smells:

- duplicate draft instead of supersession
- accepted meaning not showing up in the next-turn prompt
- transport action narrated as complete before commit

## SDK Helpers Added For Cleaner Apps

- `buildAssistantHistoryMessage(message, results)`
  Builds the assistant message that should be stored in history and appends only executed action annotations.

- `getExecutedAnnotations(results)`
  Returns annotations for actions that actually executed successfully.

These helpers reduce app-level duplication and make hidden-operation behavior easier to keep consistent across apps.

See [REFERENCE_APP.md](REFERENCE_APP.md) for the recommended production app shape, and [ACTION_CONTRACTS.md](ACTION_CONTRACTS.md) plus [BOUNDARY_NORMALIZATION.md](BOUNDARY_NORMALIZATION.md) for the two most common contract/integration failure surfaces.

See [WORKING_SET.md](WORKING_SET.md) for the accepted-by-default runtime and migration model.

## Reference Implementation Guidance

Archetype should eventually ship a canonical reference app or example set that demonstrates the patterns that repeatedly mattered in production:

- explicit action contracts with good examples
- managed history plus hidden executed-action annotations
- rich-text chat rendering
- follow-up chips / reply affordances
- thin app-boundary normalization for domain invariants
- live and deterministic eval coverage

What should stay app-specific:

- domain semantics like timed exercise handling, money/range/unit normalization, or calendar merge rules
- product-specific rendering and UI taste
- workflow constraints that only make sense inside one app

## The Default Debugging Loop (2026-04-22)

When a persona misbehaves, follow `auditPersona` → `dumpPromptForReview` → `auditTraceIntegrity` in order. Full loop documented in [DEBUGGING_LOOP.md](DEBUGGING_LOOP.md). Never hand-compose audits per persona; that's what `auditPersona` exists to prevent.

## Benchmark Harness Responsibilities (2026-04-21)

A persona's benchmark harness is not just "loop turns through `engine.chat()`." To test anything meaningful, the harness has to mirror what production does between turns. Three responsibilities, in order of how badly each one misleads your scores when missed:

### 1. Evolve state between turns via CRUD

If the AI creates a meal in turn 2, turn 3's context must show that meal in the ledger. Otherwise the AI sees an unchanged ledger + its own history claiming "I logged the smoothie" and rationally reconciles by re-logging — which the judge correctly penalizes as a hallucinated action.

Use `runEvalConversation` (`src/evals/runtime.ts`) as the reference — it resolves temp IDs, dispatches memory/craft CRUD, and routes domain CRUD through app-provided handlers. Hand-rolled harnesses should match this shape — in production use, skipping this step regressed a memory-recall scenario by 12 points until the harness was fixed.

### 2. Fixture memories should match what real extraction writes

When a scenario hand-places a memory, it's simulating what some earlier extraction pass would have produced. If the fixture memory shape doesn't match what your actual extraction writes, the test is measuring noise on a worst-case input your real users will never hit.

Validate before trusting the fixture. Drive the persona against the scenario's pre-history with a neutral continuation and observe the CRUD the extraction AI emits (trace the extraction CRUD your app emits and read it directly). If your extraction handles the case cleanly, either rewrite the fixture to match extraction output — making the scenario a positive-path test — or drop the scenario. Don't leave hand-mislabeled memories in place; they'll keep flickering and you'll keep chasing ghosts.

### 3. Audit the assembled prompt against the scenario context

`auditPrompt({ config, context, memories })` assembles the full system prompt the LLM would actually see (same path as `chat()`) and hands it to the LLM meta-judge. The judge flags structural issues — `signal-dilution`, `rule-density`, `duplicate-across-layers`, `not-visible-in-context`, etc. — against this persona, in this scenario.

Run it. Signal-dilution in particular (same concept stated 3+ times in different wordings) is invisible to static audits and commonly drives variance. During this work pass, the LLM meta-judge caught four separate framings of "live conversation > stored memory" that the static audits had rubber-stamped. Consolidating them moved Boxed Corrective Memory from ~70 to ~90+ mean.

Any non-trivial scenario is worth one `auditPrompt` invocation when the scenario first lands and again whenever the persona prompt changes.

## Load-Bearing Invariants (2026-04-21)

The audit stack pushes toward pruning prescriptive content. That's correct for 99% of prompts. But a small number of sentences look exactly like the anti-patterns the audits flag — abstract, prose-y, not naming a specific mechanic — while actually defusing a default LLM prior that would otherwise produce a reliable failure.

`src/playbook/invariants.ts` names each such sentence with a doc comment explaining the failure mode it prevents and the canary scenario that regressed when it was removed. `tests/load-bearing-invariants.test.ts` asserts each invariant appears in the assembled prompt of a foundation config. Removing one requires running the canary scenario first, proving it still passes, and landing a PR with the benchmark diff.

Current five:

1. `JUDGMENT_OVER_LITERALISM_NUDGE` — "Use the real situation over the most literal reading of every sentence in this prompt."
2. `PRECEDENCE_OF_SIGNALS_NUDGE` — "When the live conversation contradicts a memory, update or delete the stale memory through the crud action in this turn."
3. `MATCH_MESSAGE_TO_ACTIONS_NUDGE` — "If your message narrates a change, the corresponding action or crud call must also appear in this turn's output."
4. `MEMORY_SELF_BOX_WARNING` — "Every stored memory comes from a specific moment. Check whether the situation that made it true still holds."
5. `CONTEXTHINT_CAPTURES_THE_WHY` — "contextHint: the situation that produced the memory. For corrections or instructions tied to a moment, contextHint is not optional."

Add new ones sparingly, and only with a scenario + benchmark diff attached. Every invariant is another thing a future cleanup pass can't prune.

## Recommended Next Steps

1. Add adversarial eval suites that try to force duplication, stale memory, and over-eager actions.
2. Add automated regression thresholds so a persona can fail CI when its pairwise or conversation score drops materially.
3. Promote the eval harness from internal test utility to a documented Archetype feature.
