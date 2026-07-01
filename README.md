# Archetype

A TypeScript SDK for building AI expert personas — coaches, guides, assistants — that feel human, remember what matters, and act reliably inside real products.

Define your persona in ~50 lines of config. Archetype handles prompt assembly, structured actions, memory that compounds over time, and the behavioral guardrails that make AI companions feel natural instead of robotic.

## Philosophy

Archetype is built on a single principle: **scenario-first, not directive-first.** The AI persona is the domain expert. Your job is to paint the situation — context, memories, history, constraints — and describe what good looks like. Not to tell the AI what to say, when to act, or how many things to do. Hard rules exist only for mechanical correctness (JSON format, schema compliance). Everything else is a thinking nudge. See [PLAYBOOK_ESSENTIALS.md](PLAYBOOK_ESSENTIALS.md) for the full design philosophy.

## Vision

Archetype exists to help build AI experts that create real human value now: a nutritionist, trainer, financial advisor, coach, or personal assistant that feels like a real counterpart, earns trust, and improves lives through an ongoing relationship.

The long-term vision is not a boxed chatbot or a manager-worker graph. It is a network of roles where some participants are human and some are AI, collaborating through shared ledgers, channels, memory, and authority.

Archetype's bet is that most agent failure comes from poor framing, incomplete world exposure, or missing operating surfaces, not from a lack of rules. Trust the model for judgment. Use the runtime for mechanical enforcement.

That means:

- let experts think instead of boxing them into scripts
- model shared truth in ledgers, not only messages
- represent governance as much as possible through roles and institutions, not centralized orchestration
- keep a hard firewall for platform invariants like schemas, permissions, commit integrity, and auditability

## Quick Start

```ts
import { definePersona, withStorage, commitCrud, Gemini } from 'archetype'
import { z } from 'zod'

const engine = definePersona({
  identity: {
    name: 'Chief',
    expertise: ['prioritization', 'follow-through'],
    relationship: 'sharp chief of staff',
    northStar: "the operator's clarity and leverage",
  },
  voice: { tone: 'balanced', style: 'quick', medium: 'desktop-panel' },
  entities: {
    task: {
      schema: z.object({ title: z.string(), due: z.string().optional() }),
      label: 'Task',
      displayField: 'title',
    },
  },
  actions: {},                  // named actions are rare — most ops are entity CRUD
  memory: { enabled: true, includeIds: true },
  eq: { frequencyRule: true, autonomyRespect: true },
  provider: Gemini({ model: 'gemini-3-flash-preview' }),
})

const managed = withStorage(engine, {
  adapter: myStorageAdapter,   // implements StorageAdapter
  historyLimit: 30,
  memoryBudget: 8000,
})

const result = await managed.chat({
  message: 'Remind me to send the investor update Thursday morning.',
  context: { openTasks },
  userIdentity: 'Alex, CEO',
  timezone: userTimezone,      // send from the app/client
})

// result.message      — the persona's response
// result.crudActions   — entity create/update/delete (CrudAction[])
// result.actions       — named actions, if any (ParsedAction[])
// result.outcomeNotes  — what changed because of this turn
// result.followUps     — suggested next things the user might say

// In managed mode, memory CRUD is SDK-owned.
// Commit only domain entities through your app handlers.
const memoryCrudEntities = new Set(['memory', 'craftMemory'])
const domainCrud = result.crudActions.filter(a => !memoryCrudEntities.has(a.entity))

const handlers = {
  task: {
    create: async (id, params) => { await db.tasks.create({ id, ...params }); return { success: true } },
    update: async (id, params) => { await db.tasks.update(id, params); return { success: true } },
    delete: async (id) => { await db.tasks.delete(id); return { success: true } },
  },
}
const commitResults = await commitCrud(domainCrud, handlers)
if (commitResults.some(r => !r.success)) {
  throw new Error('Task commit failed')
}
```

For product apps with persistence, this is the default path: `withStorage()` + `managed.chat()` / `managed.promptedTurn()` + `entities` + `commitCrud()`.

## Architecture

Archetype is organized in three layers.

For most user-facing products, start at Layer 2.

```
Layer 0 (Core)    Pure functions. Zero state, zero I/O.
                  Identity, voice, EQ, actions, memory, context → system prompt.
                  Testable without any LLM calls.

Layer 1 (Engine)  Stateless chat. Builds prompt, calls LLM, parses response,
                  validates actions with retry/repair, and normalizes output.
                  App passes history + context in, gets result out.

Layer 2 (Managed) Optional persistence via StorageAdapter.
                  Auto-manages conversations, messages, memory extraction,
                  daily retrospectives, and working-set staging.
```

`definePersona()` returns a stateless engine. For product apps, wrap it with `withStorage()` and stay in managed mode. Use Layer 1 directly only when another system already owns persistence and lifecycle.

### Which Layer To Start With

- `Layer 2 (managed)`:
  Product apps, chat products, assistants, coaches, guides, tools with persistence, memory, traces, or working-set state.
- `Layer 1 (stateless)`:
  Advanced or embedded integrations where another control plane already owns history, storage, approvals, and execution.
- `Layer 0 (core)`:
  Testing prompt assembly or building low-level SDK features.

```ts
import { definePersona, withStorage, Gemini } from 'archetype'

const engine = definePersona({ /* config */ })

const managed = withStorage(engine, {
  adapter: myStorageAdapter,   // you implement this interface
  historyLimit: 30,
  retrospect: {
    auto: true,                // run daily retrospective before first turn
    guidelines: 'Look for repeated patterns and stable preferences.',
  },
})

const result = await managed.chat({
  message: userMessage,
  context: { threads: myData },
  timezone: userTimezone,
})
```

### Smells You Are Rebuilding Layer 2 Locally

- manually loading and trimming history before every turn
- manually saving assistant messages after every turn
- manually applying memory CRUD in app code
- custom CRUD dispatch loops instead of `commitCrud()`
- converting named actions into CRUD after the fact
- patching model omissions in code instead of improving the scenario or entity contract

### Smells You Are Boxing The Model

- adding "do not do X again" prose after a failed operational turn
- coercing malformed action names into nearby valid ones before checking the prompt
- hiding actionable objects in prose summaries instead of exposing real IDs
- duplicating large app-written API docs on top of the SDK contract block
- blaming the model before reviewing the exact provider-boundary prompt

If an operational persona fails, inspect the exact prompt and trace first.
Most early failures are operating-surface failures, not intelligence failures.

### Inspect The Exact Provider Request

When you want to review what the model actually sees at the provider boundary, use the exact request builders instead of reconstructing prompts by hand:

- `buildChatLLMRequest(config, input)`
- `buildPromptedTurnLLMRequest(config, input)`

These return the real `systemPrompt`, `history`, `message`, and `responseSchema` that Layer 1 will send to the provider.

That matters for three common paths:

- full chat: `chat()` -> `buildChatLLMRequest(...)`
- app-initiated conversation: `promptedTurn({ turnKind: 'proactive-conversation' })` -> `buildPromptedTurnLLMRequest(...)`
- operational step without a user message: `promptedTurn({ turnKind: 'operational' })` -> `buildPromptedTurnLLMRequest(...)`

If you are doing prompt review, eval baselines, or debugging regressions, prefer these helpers over stitched prompt snippets. They keep review aligned with runtime.

For the release discipline around prompt changes, see:

- [docs/FOUNDATION_PROCESS.md](docs/FOUNDATION_PROCESS.md)

To refresh the reviewed keystone prompt fixtures for the three endpoint types, run:

- `npm run golden:update`

## Key Concepts

### Entity CRUD (primary pattern)

Most domain operations are create/update/delete on entities. Declare entities in your persona config with a Zod schema.
The model-side contract is: emit entity mutations inside the main `actions` array as `{ "name": "crud", "params": { ... } }`.
Archetype then validates and normalizes those entity mutations into `result.crudActions` for your app code.
If raw model output falls back to a legacy top-level `crudActions` key, Archetype still normalizes it for compatibility, but the trace marks that as contract drift.

```ts
entities: {
  meal: {
    schema: z.object({ name: z.string(), calories: z.number().optional() }),
    label: 'Meal',
    displayField: 'name',
  },
},
actions: {},  // empty — named actions are rare
```

After `chat()`, handle normalized entity changes through `commitCrud`:

```ts
import { commitCrud } from 'archetype'

await commitCrud(result.crudActions, {
  meal: {
    create: async (id, params) => { /* ... */ return { success: true } },
    update: async (id, params) => { /* ... */ return { success: true } },
    delete: async (id) => { /* ... */ return { success: true } },
  },
})
```

### Named Actions (rare — non-entity operations)

Named actions exist for the rare operations that don't fit entity CRUD — things like sending an email or triggering an external workflow. Define them with Zod schemas. Archetype validates the LLM's output against the schema, retries once on invalid params, and returns `ParsedAction[]`.

```ts
actions: {
  sendEmail: {
    description: 'Send an email when the user explicitly asks.',
    schema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
    confidence: 'low',
  },
}
```

Confidence controls the trust model: `low` auto-executes, `medium` follows the approval mode, `high` always proposes for review.

For app-initiated operational turns, Archetype renders these as execution semantics instead of human confirmation language. Use `promptedTurn()` for those turns so the persona wakes up into a system rather than pretending a person just asked it something.

## Operational turns

Archetype supports two prompt modes:

- `conversation`
- `operational`

`chat()` defaults to `conversation`.
`promptedTurn()` defaults to `operational`.

Use `operational` when:

- nobody sent a fresh message
- the role is waking up into ledgers / queue / commitments / world state
- the role is expected to mutate shared state, not just reply conversationally

See [PROMPT_MODES.md](PROMPT_MODES.md) for the full split, launch checklist, and anti-boxing guidance.

### Memory

Memory compounds the experience across conversations. The SDK handles:

- **Budget-aware loading** — pinned memories first, then recent, respecting a character budget
- **CRUD-native memory** — memory and craft memory are normal entities, not a parallel side channel
- **Domain categories** — declare your own taxonomy so the LLM categorizes with domain awareness
- **Silent retrospection** — periodic reflection pass that creates/updates/deletes memories without user-facing output
- **Compaction** — LLM-driven dedup of old memories to keep the set sharp

```ts
memory: {
  enabled: true,
  includeIds: true,
  budget: 8000,
  categories: {
    preference: 'Dietary preferences, food likes/dislikes',
    routine: 'Eating patterns, meal timing',
    health: 'Health conditions, goals, energy patterns',
  },
  purpose: 'The handful of things worth knowing before future conversations.',
},
```

### Working-Set Staging

For apps where the AI proposes changes that the user reviews before they take effect.

Two layers of mutations:
- **Meaning layer** — drafts, classifications, internal state. Become current truth immediately.
- **Transport layer** — external effects (API calls, database writes). Staged for explicit commit.

```ts
import { reviewWorkingSetDelta } from 'archetype'

staging: { model: 'working-set' },
actions: {
  setDraft: {
    description: 'Set the current reply draft.',
    schema: z.object({ threadId: z.string(), draft: z.string() }),
    layer: 'meaning',
    defaultReviewState: 'accepted',
    commitMode: 'not_required',
    targetKey: (params) => `thread:${params.threadId}:draft`,
  },
  archiveThread: {
    description: 'Stage archiving this thread.',
    schema: z.object({ threadId: z.string() }),
    layer: 'transport',
    defaultReviewState: 'pending',
    commitMode: 'explicit',
    targetKey: (params) => `thread:${params.threadId}:archive`,
  },
}
```

Deltas with the same `targetKey` automatically supersede earlier ones — the working set always reflects the latest intent.

Use `reviewWorkingSetDelta()` or managed `reviewWorkingSet()` to apply canonical accept/reject transitions before commit instead of hand-editing stored JSON.

### Side Effects

After `chat()`, execute entity CRUD through `commitCrud` (the primary pattern):

```ts
import { commitCrud } from 'archetype'

const results = await commitCrud(result.crudActions, {
  task: {
    create: async (id, params) => { await db.tasks.create({ id, ...params }); return { success: true } },
    update: async (id, params) => { await db.tasks.update(id, params); return { success: true } },
    delete: async (id) => { await db.tasks.delete(id); return { success: true } },
  },
})
```

For the rare named actions, use `executeSideEffects`:

```ts
import { executeSideEffects } from 'archetype'

const results = await executeSideEffects(result.actions, handlers, persona.config.actions!)
```

Handlers return `{ success, changed?, error? }`. The `changed` flag distinguishes "ran successfully" from "actually mutated state" — enabling honest outcome reporting to the user.

### App-Initiated Turns

Use `promptedTurn()` when your app wants the persona to speak without a user message:

```ts
const result = await persona.promptedTurn({
  intent: 'Check in at the start of a new day.',
  label: 'Morning greeting',
  context: { todayStatus: '...' },
  memories: loadedMemories,
  guidelines: 'Reference what you know. Be warm, not robotic.',
})
```

Good fits: greetings, post-interaction reflections, proactive nudges.

Important contract:

- `chat()` and `promptedTurn()` differ by who initiated the turn, not by memory semantics
- in Layer 1, both are stateless and the caller provides history, memories, and context
- in Layer 2 managed mode, `managed.chat()` and `managed.promptedTurn()` should both get the full memory lifecycle:
  - load history
  - load memories
  - run retrospective/review as configured
  - execute SDK-owned memory CRUD
  - persist traces

If an app ends up treating `promptedTurn()` as a lighter or more manual memory path, that is usually contract drift, not the intended design.

### EQ (Emotional Intelligence)

Thinking-nudges that help personas feel like experts, not bots:

- **Frequency Rule** — trust that the user heard you; find the next layer instead of repeating yourself. But if something is urgent, say it again.
- **Autonomy Respect** — when the user is processing, help them think rather than jumping to advice. When you see something important they're missing, say it directly.
- **Qualitative First** — lead with what the data *means*, not the raw numbers. Use numbers naturally when they clarify.

These are nudges, not hard rules. The persona is the expert — it uses judgment.

## Provider

Archetype ships with a Gemini adapter. The `LLMProvider` interface is pluggable:

```ts
const myProvider: LLMProvider = {
  name: 'my-provider',
  async chat(request) {
    // request: { systemPrompt, history, message, responseSchema?, temperature?, attachments? }
    const response = await myClient.generate(...)
    return { text: response.text }
  },
}
```

## What Archetype Owns vs. What Your App Owns

| Archetype | Your App |
|-----------|----------|
| System prompt assembly | Rendering and UI |
| Action validation + retry | Side-effect execution logic |
| Memory loading, extraction, review, prompt selection | Domain-specific storage (database, schema) |
| Working-set state management | Commit triggers and review UI |
| EQ guardrails | Onboarding and user management |
| Eval infrastructure | Domain invariants (units, ranges, merge semantics) |

For memory specifically, the app-side storage adapter should be a persistence boundary, not a policy engine.

Good adapter behavior:

- store the memory record faithfully
- load candidate memories for the requested scope
- preserve metadata like `pinned`, `source`, `stability`, `contextHint`

Bad adapter behavior:

- deciding which memories survive the prompt budget
- flattening or dropping memory metadata
- rewriting memories into app-specific shapes before Archetype sees them
- executing memory policy in app code because the SDK path was bypassed

In other words:

- the adapter should be able to do "store this memory", "update this memory", "load candidate memories"
- Archetype should decide how those memories are used

That split is intentional. Archetype handles the AI orchestration so you can focus on your domain.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [POSITIONING.md](POSITIONING.md) | What Archetype is, what it is not, and how it differs from orchestration-first or memory-first frameworks |
| [PRODUCT_APP_START_HERE.md](PRODUCT_APP_START_HERE.md) | The shortest clean default for real product apps using Layer 2 |
| [AI_PERSONA_PLAYBOOK.md](AI_PERSONA_PLAYBOOK.md) | Why good personas work, and what usually makes them feel robotic |
| [CLAUDE.md](CLAUDE.md) | SDK architecture, module structure, commands, and implementation patterns |
| [EVALS.md](EVALS.md) | Eval philosophy, sample personas, and the stress-testing harness |
| [ACTION_CONTRACTS.md](ACTION_CONTRACTS.md) | How to design action shapes that models follow reliably |
| [WORKING_SET.md](WORKING_SET.md) | When to use working-set staging vs. legacy batch proposals |
| [NEXT_RUNTIME_PRIMITIVES.md](NEXT_RUNTIME_PRIMITIVES.md) | The likely next 80/20 runtime additions after strong single-role chat |
| [ECOSYSTEM_SHORTLIST_2026-04.md](ECOSYSTEM_SHORTLIST_2026-04.md) | Dated external ecosystem shortlist: what to adopt, align with, watch, or avoid as core |
| [REFERENCE_APP.md](REFERENCE_APP.md) | The practical integration pattern for production apps |
| [BOUNDARY_NORMALIZATION.md](BOUNDARY_NORMALIZATION.md) | What validation should stay app-owned after the model responds |
| [ROLE_LEDGER_CHANNEL_ARCHITECTURE.md](ROLE_LEDGER_CHANNEL_ARCHITECTURE.md) | The longer-term architecture direction: roles, ledgers, channels, and firewalls |
| [PERSONA_NETWORK_ARCHITECTURE.md](PERSONA_NETWORK_ARCHITECTURE.md) | The narrower path from one expert role to peer consultation to multi-role systems |

## Examples

| Example | What it demonstrates |
|---------|---------------------|
| [coach](examples/coach/index.ts) | Executive coaching with memory and thread context |
| [nutrition](examples/nutrition/index.ts) | Nutrition guide with meal context and preferences |
| [fitness](examples/fitness/index.ts) | Strength coaching with exercise schemas |
| [language-tutor](examples/language-tutor/index.ts) | Language learning with correction style |
| [chief-of-staff](examples/chief-of-staff/index.ts) | Task management with entity CRUD |
| [working-set-assistant](examples/working-set-assistant/index.ts) | Email triage with meaning/transport staging |
| [working-set-nutrition](examples/working-set-nutrition/index.ts) | Meal planning with conversational drafts |
| [nutrition-guide](examples/nutrition-guide/server.ts) | Managed-mode reference app with knowledge and domain CRUD |
| [coder-agent](examples/coder-agent/README.md) | Focus-mode builder persona using Archetype's shared builder actions |
| [pm-spec-agent](examples/pm-spec-agent/README.md) | Focus-mode product manager that writes implementation specs to files |
| [paperclip-archetype-service](examples/paperclip-archetype-service/README.md) | Local HTTP service integration with Paperclip-owned orchestration |
| [reference-app](examples/reference-app/README.md) | Full integration walkthrough |

## Commands

```bash
npm test           # run vitest (mock providers, no API calls)
npm run test:live  # live persona + Turing evals (requires GEMINI_API_KEY)
npm run build      # TypeScript build → dist/
npm run lint       # type-check (tsc --noEmit)
npm run audit:examples # build + audit all shipped example personas
```
