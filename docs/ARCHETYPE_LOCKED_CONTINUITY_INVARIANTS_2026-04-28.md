# Archetype Locked Continuity Invariants

Date: 2026-04-28

## Purpose

This document locks the conclusions that kept getting rediscovered and then
accidentally undone during the Foundry, PM-builder, and PI comparison work.

The goal is not to make a better one-off PM or builder prompt. The goal is to
protect the Archetype concept: a capable AI persona operates from a truthful
world picture, with Archetype owning continuity, tool/action reality, memory,
ledgers, and focus semantics.

If a future trace appears to contradict this document, do not patch around it.
Name the invariant it appears to contradict, stop implementation, and ask the
human owner for explicit permission to reopen that invariant before changing
docs, tests, prompts, schemas, tool surfaces, or code.

Evidence can justify a request to reopen an invariant. Evidence is not permission to rewrite one.

## Locked Invariant 0: Invariants Require Explicit Human Approval To Reopen

Locked invariants are product architecture, not ordinary implementation detail.

A coding agent must not modify, weaken, reinterpret, rename, or route around a
locked invariant on its own, even when the current trace strongly suggests the
invariant is wrong.

Required process:

1. Quote or link the exact invariant that appears contradicted.
2. Quote or link the exact trace/prompt/tool evidence that contradicts it.
3. State the proposed replacement invariant.
4. Stop and ask the human owner for explicit approval to reopen the invariant.
5. Only after approval, update docs, tests, code, prompts, and downstream
   consumers.

This applies especially when the change feels obviously correct. "Obviously
correct" is how conceptual drift bypasses the lock.

Forbidden without explicit approval:

- changing a locked invariant doc,
- changing a test that enforces a locked invariant,
- changing an action schema or default tool surface in a way that contradicts a
  locked invariant,
- using a benchmark win/loss to replace a locked invariant,
- saying "the evidence is strong enough" and implementing anyway.

## The Keystone

The agent is capable. When it makes a weak move, assume the context, tool
contract, continuity, or world state made that move reasonable.

Do not solve weak output by boxing the agent. Solve the world picture.

## Locked Invariant 1: Archetype Owns Action Continuity

Future turns must not receive raw action payloads as normal model history.

The model-facing continuity stream is chronological:

```text
self note
compact action narration
factual action outcome
result when it is still live
tombstone when the full result has decayed
next self note
next compact action narration
next factual action outcome
```

This is the Archetype contract:

- `readFile` can show file contents as the action result.
- The file contents are carried only for the configured live window.
- After decay, the model sees a tombstone such as "result removed from active
  context; read again if exact contents are needed."
- Bulk mutations summarize the result, for example "updated 100 records
  successfully", not 100 raw mutation payloads.
- Action failures appear in the same chronological stream as the agent's own
  note, so "I am updating X" and "update failed because Y" are read together.
- Attempted actions appear as compact natural-language action narration, not as
  raw action JSON or provider tool-call dumps.
- The action narration exists so the future agent understands what it tried and
  why the outcome matters. It must not preserve raw params, large file bodies,
  obsolete action schemas, or vendor-specific call payloads in prompt history.
- Raw action calls, params, provider payloads, and large bodies belong in audit
  artifacts, not future prompt history.

This is the unique Archetype value. It is not optional host behavior.

## Locked Invariant 2: Do Not Switch To Native Provider Tool History

Do not "fix" Archetype by switching the product contract back to native provider
tool-call history.

Native provider tool calls can be useful as a transport detail, but they do not own Archetype continuity. They preserve the vendor's transcript shape, which can
replay large action payloads, long CRUD batches, file bodies, or implementation
details into future context. That is exactly the problem Archetype solves.

PI can score well with native tool transcripts because its harness and task are
small enough for that tradeoff. Archetype must support larger work:

- 100 CRUD records updated in one turn.
- multi-megabyte files.
- long-running focus work.
- memory and craft-memory surfaces.
- multi-persona sessions.
- private focus notes plus visible chat.

For Archetype, the visible model history is outcome continuity, not native raw
tool replay. If native function calling is used internally, its output must still
respect Archetype's outcome-continuity contract.

## Locked Invariant 3: Do Not Drift File Editing Concepts

Do not replace the chosen builder edit concept because one trace made it look
fragile.

The current builder file mutation concept is two simple expert moves:

- `writeFile` creates or replaces a whole file when the agent knows the desired
  complete content.
- `applyPatch` makes targeted edits to existing files when the current file
  context is known.

Both actions must return compact factual outcomes. Future turns see "wrote
index.html, 126 lines" or "patch updated game.js", not the raw file body or raw
patch payload.

`applyPatch` is still the targeted edit primitive:

- It accepts one git-style unified diff patch.
- One `applyPatch` action is atomic internally.
- Multiple `applyPatch` actions in one turn are allowed for independent durable
  steps.
- A successful earlier `applyPatch` remains applied when a later independent
  `applyPatch` fails.
- When `applyPatch` fails, the outcome explains the failed editing contract in
  agent-useful terms: the patch expected context that did not match the current
  workspace state, no files changed, and the agent can read the affected files
  if exact current contents are not already in prompt.
- `runTests` and `finishAttempt` do not run after an earlier same-turn failure,
  because their result would falsely describe verification or completion of a
  turn where an intended tool action failed.
- Every action is documented as an attempt. The persona chooses the whole
  same-turn action list before seeing outcomes. The following turn carries what
  actually happened: successes, failures, skipped verification/completion, and
  carried-forward read results.
- A same-turn visible completion, verification, or handoff message cannot
  reflect outcomes the persona has not seen yet. If that message depends on
  verification actions in the current turn, the clean move is to run the
  verification first, let the outcomes return in the next turn, then decide what
  to say.

Do not collapse these tools back into one vague "edit" primitive. Do not remove
`writeFile` because raw file bodies are large; the continuity layer owns that by
showing compact outcomes instead of raw payloads. Do not replace `applyPatch`
with `editFile` exact-block matching; targeted diffs remain the durable patch
contract.

If `applyPatch` fails in a trace, debug the exact prompt, patch, file state,
action outcome, and executor behavior. Fix the implementation or context if it
is wrong. Do not rename the problem into another tool.

## Locked Invariant 4: Source Files Are Visible; Contents Are Chosen By The Persona

Do not hide source material from the opening world picture, and do not inject
the source material as a hidden host-authored work item.

The opening prompt should show source files in the factual file tree with useful
size signals, for example:

```text
- input/ — read-only, source material for the shared project
-   input/game-brief.md — 80 lines, 2664 bytes
```

That tells the persona the source exists. It does not force the persona to read
it, summarize it, or enter focus. A capable persona can decide the right next
move from the visible request, available files, tool contracts, and workspace
state.

Locked behavior:

- FILES shows relevant source files from turn one.
- FILES shows path, mutability, purpose, line count, and byte count where
  available.
- The prompt does not embed full source contents unless an action, attachment,
  memory/entity surface, or user message actually supplied those contents.
- The host does not convert source material into a hidden WORK ITEM.
- The persona can use `readFile` when contents matter; that result enters
  chronological outcome continuity.

This was a root cause in the PM-builder loop: when the PM could not see
`input/game-brief.md` on turn one, writing from the title alone was a reasonable
mistake. When the file was visible from turn one, the PM chose `readFile` and
then entered focus with its own work item.

## Locked Invariant 5: The Host Does Not Author The Work Item

Do not hard-code a better work item for the persona.

The normal flow is:

1. The user or teammate sends a visible request.
2. The persona understands the request.
3. The persona creates or updates durable work state, specs, files, ledgers, or
   memories when that is the natural move.
4. If the persona enters focus, focus centers the persona-authored active work
   state and source material.
5. The host persists and renders that state truthfully.

The host may store, render, route, and preserve the active work item. The host
must not secretly author a stronger work item, hidden spec bundle, hidden team
chat, hidden schedule, or hidden handoff packet to compensate for the agent.

If the PM creates a weak work item, debug the visible request, live context,
durable-state tools, action outcomes, and focus entry contract. Do not replace
the PM with host-authored prompt text.

Focus work items are persona-authored future operating context. They are an
expert anchor for the persona who wrote them, layered on top of source truth,
visible conversation, durable files, and tool outcomes. They are not a
replacement source of truth, and they are not a hidden handoff that narrows
another expert's ownership of method, sequencing, tools, or implementation
approach.

The focus action may offer the persona this opportunity:

- describe the expert judgment lens to hold,
- describe the work or product spine,
- describe what excellent success feels like,
- describe the manageable parts the future self should reason through.

That text is not a host-authored nudge. The persona writes it, the runtime
persists it, and future focus prompts render it as factual active work context.

This distinction matters. A good PM focus work item can anchor player promise,
core loop, product tradeoffs, reviewability, and acceptance lens. It should not
turn into "Builder, start by setting up project structure, implement the state
machine, and render the grid" unless those implementation details are real
source constraints. A good builder focus work item can be implementation-shaped
because implementation is the builder's ownership.

## Locked Invariant 6: Workspace Paths Have One Canonical Visible Name

Do not give the persona two names for the same durable file.

In a mounted workspace, every file has exactly one canonical visible path:

```text
input/game-brief.md
spec/product-spec.md
artifact/index.html
```

That same visible path is what appears in FILES, what first-party file actions
accept, what action outcomes report, what handoffs should reference, and what
both arbitrary sandbox commands and fixed sandbox preset tools see when they
run inside Archetype's mounted workspace view.

Locked behavior:

- FILES renders mounted files with their mount prefix.
- Mounted file actions do not silently treat `index.html` as an alias for
  `artifact/index.html`.
- `runCommand` in a mounted workspace runs with a cwd that contains the visible
  mount directories, so shell paths can match FILES.
- Fixed sandbox preset tools such as `runTests`, `runBuild`, and `runLint`
  receive the same visible mounted cwd when a host implements them through
  Archetype's coder executor. Their preset semantics may be host-owned, but
  their path world must not silently drift away from FILES.
- `runCommand` file-change outcomes report canonical visible paths.
- Prompt audit fails if hidden default aliases such as "default for unprefixed
  file actions" return.
- Prompt audit fails on nested virtual mount paths such as `artifact/artifact/`
  or `spec/spec/`.

This invariant prevents the recurring path spin: first `artifact/index.html`
was a file-action path, then `index.html` was a shell cwd path, then
`artifact/artifact/index.html` was created, then later fixes tried to explain
or repair the split. The split was the bug. Archetype must provide one path
world.

Browser URLs may still be served from a live document root; that is a URL
mapping, not a second file name for durable workspace state.

## Locked Invariant 7: PI Is A Benchmark, Not The Architecture

PI is useful because it shows whether the same model can do better with a
simpler harness. PI is not automatically the architecture to copy.

When PI beats Archetype:

- Do compare the exact prompts, tool contracts, tool outcomes, and artifact
  quality.
- Do ask what world fact PI made clear that Archetype obscured.
- Do ask what action result PI preserved that Archetype lost or split.
- Do ask what product intent PI kept central that Archetype diluted.
- Do not conclude "use native tool calls."
- Do not conclude "hard-code a better work item."

If PI succeeds because its tool outcome says "Could not find the exact text"
while Archetype says "git could not apply", the lesson is diagnostic action
truth, not vendor transcript adoption. If PI succeeds because it uses whole-file
write for whole-file content, the lesson is to keep `writeFile` as a first-class
whole-file primitive while preserving Archetype's compact outcome continuity.

New benchmark evidence must be reconciled with locked invariants before any
design recommendation. A recommendation that replaces these invariants without
naming and reopening them is a regression.

## Locked Invariant 8: Audit Must Capture The Full Forensic Story

Every serious run must make the full story inspectable:

- prompt sent to the model,
- raw model response,
- parsed actions,
- raw action params,
- action outcomes,
- next-turn continuity as rendered to the model,
- display-only/audit-only payloads that were stripped from model history.

Prompt dumps are not only for the text the model saw. They must let a future
developer prove why a tool failure, weak move, or contradiction happened without
guessing.

## Locked Invariant 9: Benchmarks Are Observation, Not Live Repair

A benchmark run is for observing the real agent/harness system, preserving the
trace, and scoring the result. It is not an interactive patch session.

During a benchmark run, do not change prompts, action docs, tool behavior,
routing, work items, source files, timeout policy, model settings, judge criteria,
or app harness logic because a turn looks weak. Let the run finish, preserve the
full prompt/output/action trace, score it, and then diagnose from the earliest
weak turn.

The only acceptable reason to discard and restart a run midstream is an invalid
run mechanical failure, for example:

- API key or provider configuration is missing,
- the model request times out or retry handling corrupts the original prompt,
- the audit prompt dump is missing or incomplete,
- the harness crashes before the agent can produce an artifact,
- the wrong model, stale package, wrong input brief, or wrong workspace was used.

Everything else is evidence, not permission to repair the run in place.

After the run, classify the earliest failure before editing code:

- broken tool/action contract,
- missing, stale, or contradictory context,
- app orchestration bug,
- locked-invariant contradiction that needs explicit human approval to reopen,
- agent judgment failure that should be scored as-is with no framework change.

Only promote a fix into Archetype when it is an invariant-level contract problem
with a small repro test. Do not use one lower benchmark score to replace
`writeFile`, replace `applyPatch`, switch to native provider history, hard-code a
better work item, hide `finishAttempt`, add completion vetoes, or add quality
nudges. Those are locked invariants, not benchmark knobs.

## What Is Not Allowed Without Reopening This Document

- "PI scored higher, so switch to native tool-call history."
- "The patch failed, so replace `applyPatch` with `writeFile` or `editFile`."
- "The PM made a weak work item, so the host should create a better one."
- "The agent finished too early, so the runtime should veto completion."
- "The artifact was shallow, so add instructions telling the builder not to be
  shallow."
- "The app needs custom prompt knobs to shape this one persona."
- "The shell uses `index.html`, but file actions use `artifact/index.html`."

These are the historical spiral paths. They are not neutral alternatives.

## How To Use This During Debugging

Before changing Archetype or Foundry because a run scored badly:

1. Read this document.
2. Read the full prompt dump for the earliest weak turn.
3. Read the exact model output and action outcomes.
4. Identify the world fact, tool result, or continuity surface that made the weak
   move reasonable.
5. Make the smallest mechanical-truth or context-clarity fix.
6. Add a test that preserves the invariant touched by the fix.

If the proposed fix changes one of these invariants, stop and explicitly ask to
reopen the invariant.

## Locked Evidence: PM-Builder 9/10 Recovery Trace

On 2026-04-29, the Foundry PM-builder journey reached an external judge score
of 9.0/10 after the following foundation fixes:

- source files were visible in FILES from turn one without embedding source
  contents,
- `enterFocusMode` gave each persona an opportunity to author future operating
  context,
- both PM and builder focus mode used persona-authored work items,
- `applyPatch` and `editFile` documented exact-context requirements,
- `applyPatch` failure recovery pointed to reading exact affected file contents
  instead of drifting tool concepts,
- Foundry used the Archetype focus/action infrastructure rather than a hidden
  PM-builder team-chat mechanism.

The trace showed the intended behavior: PM turn 1 saw `input/game-brief.md`,
chose `readFile`, entered focus with its own work item, wrote a spec, the builder
read the spec, entered focus with its own work item, built and browser-tested the
artifact, and PM reviewed/patched an edge case.

Do not treat a future lower score as permission to undo these fixes. Read the
earliest weak prompt and identify the missing world fact, tool truth, or
continuity failure.
