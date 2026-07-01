# Reference App Pattern

This is the practical Archetype app shape that emerged from building and tuning real products — a nutrition guide, a CEO coaching app, and a fitness coaching app.

The goal is not to make every app identical.

The goal is to standardize the parts that repeatedly matter:

- strong persona philosophy
- explicit entity / action contracts
- working-set persistence when accepted drafts should carry across turns
- executed-only history hygiene
- rich chat rendering
- thin app-boundary normalization
- real eval coverage

## The Shape

For most real product apps, this reference shape assumes Layer 2 managed mode. Layer 1 remains valid for stateless or externally orchestrated integrations, but it should be the exception path, not the default product posture.

If you want the shortest version first, read [PRODUCT_APP_START_HERE.md](PRODUCT_APP_START_HERE.md). If you want the public thesis and category framing, read [POSITIONING.md](POSITIONING.md).

### 1. Persona config defines stable taste

The persona should own:

- relationship
- north star
- tone and style
- action definitions
- memory policy
- prompt-level taste

It should not carry a giant pile of brittle behavioral rules.

### 2. The app sends a rich live scenario every turn

The app should send:

- current context
- recent history
- memories
- relevant knowledge documents when durable reference truth matters
- time and timezone
- current user message

Behavior should mostly come from this live scenario, not from static prompt law.

If the app is initiating the turn itself, do not fake a user message just to get the model to talk.

Use `promptedTurn()` for things like:

- greetings
- post-event reflections
- proactive nudges
- short coach notes triggered by app state

That keeps history honest while still letting the app set scene and intent.

Be explicit about which app-initiated turn you are running:

- `promptedTurn({ turnKind: 'proactive-conversation' })`
  The app started the turn, but the assistant is still speaking to a person in normal conversation.

- `promptedTurn({ turnKind: 'operational' })`
  The app started the turn and the assistant is waking up into a system, queue, institution, or other operational state.

Do not rely on the old implicit default if the distinction matters. This is one of the easiest ways for new apps to drift into the wrong scaffold.

When you need to review or snapshot the exact provider-boundary request for one of these turns, use Archetype's request builders:

- `buildChatLLMRequest(config, input)`
- `buildPromptedTurnLLMRequest(config, input)`

Those helpers expose the exact `systemPrompt`, `history`, `message`, and schema the provider will receive. Use them for prompt review, eval fixtures, and regression guards instead of hand-assembled approximations.

If you are simplifying prompts or moving rules out of an app and into Archetype, compare the new exact request against a saved baseline and rerun behavior evals. Shorter is better only if the model still behaves at least as well.

Before propagating those changes beyond a single app, follow the Archetype foundation gate:

- [docs/FOUNDATION_PROCESS.md](docs/FOUNDATION_PROCESS.md)

Use `retrospect()` when the app wants a silent memory-maintenance pass.

Good fits:

- a once-per-day reflection before the first visible turn
- noticing repeated behavior that should become memory
- updating or deleting stale memories without forcing the live chat to do all the learning

The app should describe the situation and intent, not micromanage the output. The durable pattern is "here is what happened lately, decide if memory should change" rather than brittle quotas like "choose exactly 1-2 memories."

When the app has durable shared reference material — capabilities, policies, playbooks, approved claims — treat that as a separate knowledge surface, not as giant prompt prose and not as ordinary memory. In Archetype this can be passed directly as `knowledgeDocuments` or loaded through a managed knowledge adapter.

If the app supports image upload, use the same posture:

- send the real image only on the live turn
- let the model emit compact factual carry-forward notes only when they would help later
- store those notes invisibly
- feed them back in as prior image context on later turns

That preserves continuity without bloating every future request or pretending the model can still inspect the old binary.

### 3. Entity CRUD: the primary integration boundary

Declare entities in your persona config with a Zod schema. The model-side contract is to emit entity mutations inside `actions` as `{ "name": "crud", "params": { ... } }`.
The SDK then validates and normalizes those into `result.crudActions` for the app boundary. This is the primary pattern for all domain operations.

```ts
entities: {
  task: {
    schema: z.object({ title: z.string(), due: z.string().optional() }),
    label: 'Task',
    displayField: 'title',
  },
},
actions: {},  // empty — named actions are rare
```

After `chat()`, handle entity changes through `commitCrud`:

```ts
import { commitCrud } from 'archetype'

// In managed mode, memory CRUD is handled automatically.
// Filter it out and commit only domain entities.
const memoryCrudEntities = new Set(['memory', 'craftMemory'])
const domainCrud = result.crudActions.filter(a => !memoryCrudEntities.has(a.entity))

await commitCrud(domainCrud, {
  task: {
    create: async (id, params) => { await db.tasks.create({ id, ...params }); return { success: true } },
    update: async (id, params) => { await db.tasks.update(id, params); return { success: true } },
    delete: async (id) => { await db.tasks.delete(id); return { success: true } },
  },
})
```

Named actions are rare — use them only for non-entity operations like sending an email or triggering an external workflow. Those still use `executeSideEffects()`.

The execution pattern is `commitCrud()`, not `executeSideEffects()`. Entity CRUD is the default integration boundary between the AI and your app.

### 4. The model returns structured mutations, not direct database writes

Archetype returns typed mutations:

- normalized `crudActions` for the primary entity-CRUD path
- named `actions` for the rare non-entity path

The important nuance is:
- raw model output should put entity mutations inside `actions` with `name: "crud"`
- `result.crudActions` is the SDK-normalized app boundary
- if the raw model falls back to a legacy top-level `crudActions` key, treat that as prompt/schema drift even if Archetype can still recover it

The app then:

- validates them
- executes them
- normalizes true invariants when needed
- stores only what actually executed

Trace cleanliness is a first-class requirement, not a nice-to-have. For important product turns, treat these as hard gates in tests or evals whenever possible:

- `repairAttempted === false`
- `errors.length === 0`
- no `unknown_action`
- no invalid named actions
- no invalid CRUD actions
- no raw top-level `crudActions` drift

If the app enables `staging.model = 'working-set'`, there is one more layer:

- meaning-layer deltas become the current conversational truth
- transport-layer deltas stay `ready` until explicit commit

That means the app usually needs:

- working-set persistence
- a commit path for transport actions
- app-specific review affordances

The important posture is:

- prompt for judgment
- keep the live scene rich
- let the runtime carry staging semantics
- let the app carry the final mutation boundary

If the app has persistence, conversation history, memories, traces, or working-set state, the shortest clean path is usually:

- `definePersona()`
- `withStorage()`
- `managed.chat()` / `managed.promptedTurn()`
- `commitCrud()`

### 5. Stored history should reflect reality

Assistant history should not say an action happened unless it really happened.

Good pattern:

- execute actions
- collect execution results
- build stored assistant history from executed results only

Use `buildAssistantHistoryMessage()` when it fits your app shape.

Accepted meaning-layer deltas can shape future turns before they are written into visible history.
That is expected. The working set is not the same thing as the stored message log.

### 6. Rich text is part of the product surface

Most real apps should render assistant replies as markdown or rich text.

That usually means:

- markdown rendering
- safe sanitization rules
- compact debug rendering for stored actions
- suggestion chips / follow-up affordances

### 7. Normalize only true invariants

The app should normalize domain semantics the model should not be trusted to store canonically.

Examples:

- durations stay durations
- units are canonicalized
- updates preserve prior semantics unless explicitly changed
- destructive actions require stricter checks

Do not use normalization as a substitute for a weak action contract.

## Review Modes Are App-Specific

The shared state model does **not** imply one shared UI.

Three review modes have shown up repeatedly:

- `conversational`
  Nutrition-guide style. The working draft mostly advances through chat, with only light inline controls.

- `inline`
  Email-assistant style. The assistant brings one focused situation and a few explicit next moves in place.

- `structured`
  Coaching-app style. Dense, high-stakes changes get a dedicated review surface.

Accepted-by-default is about state, not about forcing every app into the same visible affordance.

## Meaning vs Transport Reference Flow

The clean working-set pattern is:

1. The app sends a rich live scene.
2. The assistant reasons from that scene and updates the current working draft through meaning-layer deltas.
3. The assistant may also stage transport-layer deltas for outside-world actions.
4. The app persists the working set and renders whatever review affordance fits the product.
5. If a transport delta needs review, the app applies the decision through `reviewWorkingSetDelta()` or managed `reviewWorkingSet()`.
6. The app explicitly commits transport-layer deltas through app-owned handlers.
7. Stored history reflects what actually happened, not what was merely staged.

That preserves the Archetype manifesto:

- scene first
- intent first
- current draft as conversational truth
- external reality only changes when the app commits it

Another way to say it:

- the model should understand what is happening
- the runtime should track what the conversation has currently landed on
- the app should decide when the outside world actually changes

## Smells That You Are Off Track

- you are manually loading and trimming history even though the app has persistence
- you are manually applying memory CRUD in product code
- you are dispatching entity changes through custom loops instead of `commitCrud()`
- you are converting named actions into CRUD after the model responds
- you are normalizing lots of missing fields instead of improving the live scene or entity contract
- you are using Layer 1 in a product app mainly because Layer 2 feels inconvenient

Those usually indicate that the integration is drifting away from the Archetype reference path and accumulating local patches that Layer 2 was meant to own.

## Working-Set Persistence In Managed Mode

If a persona enables `staging.model = 'working-set'`, managed storage should implement:

- `loadWorkingSet(conversationId)`
- `saveWorkingSet(conversationId, workingSet)`
- `clearWorkingSet(conversationId)`

The managed path should:

- load accepted working truth before the turn
- inject it into `chat()` or `promptedTurn()`
- persist the updated working set after the turn
- persist review decisions through `reviewWorkingSet()` rather than hand-editing JSON
- commit transport-layer deltas only through explicit app-owned handlers

## Reference Architecture

The durable shape is:

- live context
  - current situation, recent history, memories, time, attachments
- working set
  - accepted meaning-layer draft plus any ready transport-layer deltas
- app-owned commit handlers
  - the only thing allowed to mutate external systems
- honest stored history
  - what the assistant said plus only the actions that truly executed

That split keeps Archetype responsible for reasoning and state semantics while letting the app stay responsible for the product boundary.

## What This Looks Like In Practice

### An email assistant

Fit:

- inline review, transport-backed assistant
- situation-first UI
- meaning-layer reply drafts and thread state
- email actions as explicit commits

Main lesson:

- assistants should speak from the meaning layer, not from the raw transport layer

### A nutrition guide

Fit:

- persona and context are already situation-first
- markdown rendering is first-class
- conversational-first review with light inline controls

Main lesson:

- one evolving meal draft feels better than a proposal tray, as long as logging stays an explicit commit

### A CEO coaching app

Fit:

- richer persona/prompt philosophy
- structured review for dense, high-stakes changes

Main lesson:

- accepted-by-default state can still power an explicit review screen when the density of change makes that the better UX
- not every reviewed item needs to be a literal `WorkingDelta` row; a structured domain projection over the same draft/commit semantics is often cleaner

### A fitness coaching app

Fit:

- managed coach path
- rich text chat
- thin normalization around workout semantics

Main lesson:

- domain invariants like timed holds, durations, and merge semantics belong at the app boundary

## Recommended Folder Responsibilities

- `src/playbook/`
  Persona defaults and starter templates

- `src/core/`
  Pure prompt and action assembly

- `src/engine/`
  Parsing, validation, side-effect execution, assistant history helpers

- `examples/`
  Minimal runnable personas

- app repo
  Real rendering, real storage, real normalization, real product UX

## Reference Checklist

- persona is written from intent, not fear
- action contracts are explicit and typed
- update actions prefer direct fields over `field/value` when practical
- app stores only executed actions in history
- app persists working sets when accepted drafts need to survive across turns
- app renders assistant messages as rich text
- app keeps normalization thin and domain-specific
- app has at least one deterministic eval and one live eval path
