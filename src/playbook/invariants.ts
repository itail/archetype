/**
 * Load-bearing invariants — the audit stack's counterweight.
 *
 * The other audits (auditBrainBloat, auditBrainPrescriptions,
 * auditCrossLayerDuplicates, auditActionContracts) all push one way:
 * PRUNE PRESCRIPTIVE CONTENT. That's the right pressure for 99% of what
 * a developer writes. But a small number of prompt sentences look exactly
 * like prescriptions — abstract, prose-y, not naming a specific mechanic —
 * while actually defusing the default prior an LLM picks up from the
 * surrounding context. When those sentences are pruned, the audits don't
 * complain and the regression only shows up in a live scenario weeks later.
 *
 * This file gives each such sentence a NAME, a WHY, and a CANARY scenario.
 * The companion test (tests/load-bearing-invariants.test.ts) asserts each
 * invariant still appears in the assembled prompt of a foundation config.
 * If a future refactor removes one, the test fails with the doc comment
 * pointing at the failure mode the line was written to prevent.
 *
 * Adding a new invariant: add the named constant below, include a
 * ==> WHY, ==> CANARY, and ==> VERIFY section in the doc comment, and
 * add a `describe` block to the test.
 *
 * Removing an invariant: don't. If you believe one is no longer needed,
 * follow ==> VERIFY to prove the canary scenario still passes without it,
 * then propose removal in a separate PR with the benchmark diff.
 */

// ─── Invariant 1: judgment over literalism ──────────────────────────────────
/**
 * JUDGMENT_OVER_LITERALISM_NUDGE
 *
 * ==> WHY this is load-bearing
 * LLMs default to reading their prompt literally. A stored memory written
 * as an imperative ("Do not suggest X") is taken as a standing rule even
 * when the surrounding history makes clear the rule was conditional. This
 * nudge tells the AI to favor the real situation over the literal words —
 * the defusing frame that lets judgment override the literal reading of
 * any specific sentence, not just memories.
 *
 * ==> CANARY scenario
 * Savor "Boxed Corrective Memory". Without this nudge, the AI reads
 * "Do not suggest eggs or yogurt to Leah" literally and keeps the
 * restriction active even after the user says the condition lifted.
 * Baseline archetype (before the 2026-04-11 dogfood refactor) had this
 * line and scored 87.5 on the scenario; its removal dropped average
 * scores into the 34-75 range across runs. Re-adding it (2026-04-21)
 * restored the scenario to a consistent pass.
 *
 * ==> VERIFY before removing
 *   1. Run `cd savor && TURING_SCENARIOS="Boxed Corrective Memory" \
 *      npx vitest run evals/savor-benchmark.test.ts` at least 3 times
 *      without this line.
 *   2. Confirm average judge score ≥ 1.5/2 across runs.
 *   3. If it regresses, this invariant stays.
 */
export const JUDGMENT_OVER_LITERALISM_NUDGE = `Use the real situation over the most literal reading of every sentence in this prompt.`

// ─── Invariant 2: fix stale memory in the live turn ─────────────────────────
/**
 * PRECEDENCE_OF_SIGNALS_NUDGE
 *
 * ==> WHY this is load-bearing
 * Telling the AI "memories are not authority over the live situation" is
 * abstract. The AI needs the concrete rule-of-motion: when you notice a
 * memory has been contradicted by what the user just said, fix the memory
 * IN THIS TURN through crud. Without this, a well-meaning AI defers to a
 * retrospective pass that may never happen, and keeps obeying the stale
 * memory on every subsequent turn.
 *
 * ==> CANARY scenario
 * Same as JUDGMENT_OVER_LITERALISM_NUDGE — Savor "Boxed Corrective Memory".
 * With the literalism nudge, the AI can override. With this nudge, the
 * AI actively writes the fix. Together the scenario scores 100/2.0;
 * either alone scores lower.
 *
 * ==> VERIFY before removing
 *   Same procedure as JUDGMENT_OVER_LITERALISM_NUDGE.
 */
export const PRECEDENCE_OF_SIGNALS_NUDGE = `When the live conversation contradicts a memory, update or delete the stale memory through the crud action in this turn — don't wait for a retrospective pass.`

// ─── Invariant 3: memory is a working hypothesis ────────────────────────────
/**
 * MEMORY_SELF_BOX_WARNING
 *
 * ==> WHY this is load-bearing
 * Stored memories that lost their conditional context (a common output
 * of memory extraction) read to the LLM as absolute rules. This warning
 * reframes a stored memory as a working hypothesis, tells the AI to
 * check whether the condition that made it true still holds, and tells
 * the writer side to capture the why so future-you can tell a
 * still-relevant insight from an expired correction.
 *
 * ==> CANARY scenario
 * Savor "Boxed Corrective Memory" — same scenario. Third required nudge
 * alongside literalism + precedence; together they produce 100/2.0.
 *
 * ==> VERIFY before removing
 *   Same procedure. Canary is Boxed Corrective Memory. A weaker version
 *   that only tells the AI "check the condition still holds" may be
 *   enough — but removing the whole nudge regressed the scenario on all
 *   three earlier tests.
 */
export const MEMORY_SELF_BOX_WARNING = `Every stored memory comes from a specific moment. When reading one, check whether the situation that made it true still holds. When writing one, capture the situation that produced it — a correction saved without its why calcifies into a rule divorced from reality.`

// ─── Invariant 4: contextHint captures the why ──────────────────────────────
/**
 * CONTEXTHINT_CAPTURES_THE_WHY
 *
 * ==> WHY this is load-bearing
 * The `contextHint` field exists on Memory but its describe() framed it
 * as "an optional interpretability hint." For corrections and
 * situation-bound instructions, that framing is wrong — the field is
 * how you avoid producing a rule divorced from its reason. This nudge
 * makes contextHint non-optional for memories that are corrections.
 *
 * ==> CANARY scenario
 * Any scenario that stores a correction. In Boxed Corrective Memory
 * the fixture intentionally mis-extracts — storing "Do not suggest
 * eggs or yogurt to Leah" with no contextHint — to simulate the
 * failure mode this nudge guards against.
 *
 * ==> VERIFY before removing
 *   Sample memories written during situation-bound turns. Without this
 *   nudge, non-empty contextHint rate drops to single digits. Stays
 *   if that regression shows up.
 */
export const CONTEXTHINT_CAPTURES_THE_WHY = `contextHint: the situation that produced the memory. For any correction or instruction tied to a moment (illness, travel, a specific week), contextHint is not optional — without it, the memory becomes a rule divorced from its reason.`

// ─── Invariant 5: say ↔ do alignment ────────────────────────────────────────
/**
 * MATCH_MESSAGE_TO_ACTIONS_NUDGE
 *
 * ==> WHY this is load-bearing
 * LLMs naturally narrate actions in conversational prose ("I've logged
 * your smoothie") even when they don't fire the corresponding structured
 * action. This produces hallucinated-action failures: the judge sees the
 * narration in message + no corresponding CRUD action in the same turn,
 * scores action-fidelity 0, and the next turn inherits a message-vs-state
 * contradiction the AI tries to reconcile by re-performing the action —
 * creating duplicates.
 *
 * ==> CANARY scenario
 * Savor "Memory Recall & Continuity" T2 and T3 (2026-04-21). T2 AI:
 * "I've added a draft for the smoothie to your log" — no CRUD action
 * fired. T3 AI: "I've also confirmed your smoothie from earlier" —
 * also no CRUD. Judge penalizes both on action-fidelity.
 *
 * ==> VERIFY before removing
 *   Run Memory Recall & Continuity 3x. Count turns where the AI says
 *   "I've [verb]ed" in the message. Count turns where a crud action
 *   was emitted. They should match.
 */
export const MATCH_MESSAGE_TO_ACTIONS_NUDGE = `Match your words to your actions. If your message narrates a change ("I've logged…", "I've added…", "I've updated…", "I've saved…"), the corresponding action or crud call must also appear in this turn's output. Don't describe actions you aren't taking — silent narration is how past-tense promises become hallucinations future turns try to reconcile.`

// ─── Invariant 6: action results are current world state ───────────────────
/**
 * ACTION_RESULTS_ARE_WORLD_STATE_NUDGE
 *
 * ==> WHY this is load-bearing
 * In custom loops and multi-persona sessions, the current turn may be an
 * app-initiated continuation after a tool/action result. The intended shape is
 * a single chronological work stream: the persona's narration/inner voice,
 * compact natural-language action narration, and the factual outcome. Raw
 * action params must not be dumped back into the model-visible stream: they
 * can bloat or contaminate continuity, preserve obsolete action APIs, and make
 * the feed look like executable instructions rather than history. If a future
 * refactor hides the narration, splits outcomes into a different surface, raw-
 * dumps attempted actions, or fails to state that successful outcomes already
 * changed the world, the AI reasonably reads a broken world picture and may
 * repeat, undo, or distrust completed work. This is a continuity bug, not a
 * capability issue.
 *
 * ==> CANARY scenario
 * Foundry PM-builder Clockwork Courier smoke run after expert-peer handoff
 * wording (2026-04-29). The PM repeatedly called readFile even though the
 * full brief result was visible in history, because the outcome contract did
 * not explicitly state that visible results are current world state.
 *
 * ==> VERIFY before removing
 *   Run a same-actor app-initiated turn after a readFile/listFiles action.
 *   The next action should use the visible result, not repeat the same read,
 *   unless it says it needs a fresh value or exact contents have decayed.
 */
export const ACTION_RESULTS_ARE_WORLD_STATE_NUDGE = `When an action result appears in your current prompt, that action already happened. Use the result as current world state; rerun the action only when you need a fresh value or exact contents are no longer carried. Inner narration and action outcomes are one work stream: what you said or intended, compact action narration, then what actually happened. Read them together in order; the outcome is the factual state. Action narration is not a raw action dump; raw parameters are omitted because they can bloat or contaminate continuity and may reference action APIs no longer available.`

// ─── Invariant 7: expert autonomy prevents self/peer boxing ────────────────
/**
 * EXPERT_AUTONOMY_NUDGE
 *
 * ==> WHY this is load-bearing
 * Archetype's core stance is that each persona is a capable expert, not a
 * mediocre worker to be managed by rules. Boxing can happen in two directions:
 * a persona can prescribe another expert's method, or it can shrink its own
 * judgment into a checklist/work item and stop owning the work. The fix is a
 * clearer world picture and expert-owned judgment, not more behavioral rules.
 *
 * ==> CANARY scenario
 * Foundry PM-builder Clockwork Courier comparison (2026-04-29). The PM read
 * the source brief but produced a spec/handoff that preserved the checklist
 * while weakening the "shifting city / route risk" product hook. The builder
 * then wrote a focus work item around "project structure, core loop, map
 * rendering, basic movement" and shipped a functional but shallow prototype.
 *
 * ==> VERIFY before removing
 *   1. Run the PM-builder journey with prompt dumps enabled.
 *   2. Inspect the PM return-to-session message and the builder's first focus
 *      work item. They should preserve intent, context, constraints, evidence,
 *      and success picture without prescribing another expert's implementation
 *      sequence unless that sequence came from source material. The builder's
 *      work item should anchor judgment, not replace it with a checklist.
 *   3. Compare against a single-builder/subagent baseline on the same brief.
 */
export const EXPERT_AUTONOMY_NUDGE = `Treat yourself and every participant as an expert owner of their field. Share intent, context, constraints, evidence, and what great should feel like; let each expert own method, sequencing, tools, and implementation approach unless those details are real source facts or constraints. Short-lived work items anchor judgment; they do not replace it with a checklist.`

// ─── Invariant IDs (for test enumeration) ───────────────────────────────────

export const LOAD_BEARING_INVARIANTS = [
  {
    id: 'judgment-over-literalism',
    constant: 'JUDGMENT_OVER_LITERALISM_NUDGE',
    text: JUDGMENT_OVER_LITERALISM_NUDGE,
    keyConcepts: ['real situation', 'literal reading'],
    sourceSection: 'CONVERSATION_REALITY',
  },
  {
    id: 'precedence-of-signals',
    constant: 'PRECEDENCE_OF_SIGNALS_NUDGE',
    text: PRECEDENCE_OF_SIGNALS_NUDGE,
    keyConcepts: ['contradicts a memory', 'update or delete', 'in this turn'],
    sourceSection: 'CONVERSATION_REALITY',
  },
  {
    id: 'match-message-to-actions',
    constant: 'MATCH_MESSAGE_TO_ACTIONS_NUDGE',
    text: MATCH_MESSAGE_TO_ACTIONS_NUDGE,
    keyConcepts: ['match your words', "don't describe actions you aren't taking"],
    sourceSection: 'OUTCOME_NOTES_INSTRUCTION',
  },
  {
    id: 'action-results-are-world-state',
    constant: 'ACTION_RESULTS_ARE_WORLD_STATE_NUDGE',
    text: ACTION_RESULTS_ARE_WORLD_STATE_NUDGE,
    keyConcepts: ['action already happened', 'current world state', 'one work stream', 'raw action dump', 'contaminate continuity'],
    sourceSection: 'OUTCOME_NOTES_INSTRUCTION',
  },
  {
    id: 'memory-self-box',
    constant: 'MEMORY_SELF_BOX_WARNING',
    text: MEMORY_SELF_BOX_WARNING,
    keyConcepts: ['situation that made it true', 'capture the situation', 'calcifies'],
    sourceSection: 'MEMORY_ENTITY_RULES',
  },
  {
    id: 'contexthint-captures-why',
    constant: 'CONTEXTHINT_CAPTURES_THE_WHY',
    text: CONTEXTHINT_CAPTURES_THE_WHY,
    keyConcepts: ['contextHint', 'situation that produced', 'not optional'],
    sourceSection: 'MEMORY_METADATA_GUIDANCE',
  },
  {
    id: 'expert-autonomy',
    constant: 'EXPERT_AUTONOMY_NUDGE',
    text: EXPERT_AUTONOMY_NUDGE,
    keyConcepts: ['expert owner', 'intent', 'own method', 'work items anchor judgment'],
    sourceSection: 'EXPERT_AUTONOMY',
  },
] as const

export type LoadBearingInvariant = typeof LOAD_BEARING_INVARIANTS[number]
