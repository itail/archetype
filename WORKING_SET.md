# Working-Set Runtime

Archetype now supports two staging models:

- `legacy-batch`
- `working-set`

`legacy-batch` preserves the older "propose actions, maybe approve them later" flow.

`working-set` is the new model for negotiation-heavy assistants, transport-backed products, and any app where accepted changes should become the current conversational truth before they are externally committed.

Think of it this way:

- working set = current draft of reality
- prompt = worldview, taste, and judgment
- runtime = staging, supersession, persistence, and commit semantics

The working set should preserve the assistant's intelligence, not replace it with workflow rules.

## Core Idea

The assistant and user are shaping one living draft of reality.

That draft is represented as a conversation-scoped `WorkingSet` containing `WorkingDelta` items.

Each delta has:

- a `layer`
- a `reviewState`
- a `commitState`
- a `targetKey`

This is the same posture as the rest of Archetype:

- paint the live scene richly
- let the assistant reason from intent and context
- treat the accepted working draft as the current truth of the conversation
- keep external mutation explicit and honest

Working sets are not a second workflow the user has to enter. They are the state model that lets intent-first, scene-first assistants stay coherent across turns.

Another useful way to say it:

- prompts describe judgment
- runtime owns enforcement

That keeps the assistant free to infer from the situation while keeping the app honest about what actually changed in the outside world.

## Two Layers

### Meaning layer

Use this for:

- reply drafts
- meal composition
- thread classification
- clause edits
- coaching-note refinements

Meaning-layer deltas are typically:

- `reviewState: accepted`
- `commitState: not_required`

They become the current working truth of the conversation.

### Transport layer

Use this for:

- archive in Gmail
- create Gmail draft
- unsubscribe
- save to external system
- log to a ledger
- persist a reviewed draft into the app database

Transport-layer deltas are typically:

- `reviewState: accepted`
- `commitState: ready`

They are accepted in-conversation, but they do not mutate the outside world until explicitly committed.

That explicit commit is a systems boundary, not a phrasing rule for the model.
The assistant should still infer from the scene and conversation when a transport action is appropriate. The runtime distinction is about when the app actually mutates the outside world.

## Accepted By Default Means State, Not UI

Accepted-by-default does **not** mean every app needs a visible "accept all" surface.

It means:

- new meaning-layer deltas usually become the current draft immediately
- apps can let users challenge, refine, reject, or supersede them
- review affordance intensity is product-specific

Examples:

- a nutrition guide: mostly conversational, with light inline controls
- an email assistant: inline assistant-led review
- a CEO coaching app: structured review screen

## Supersession

Use `targetKey` to tell Archetype when a new delta replaces an older active one.

Examples:

- one reply draft per thread
- one meal draft at a time
- one current handling state per thread

When a new accepted delta with the same `targetKey` arrives, the prior active delta becomes `superseded`.

## Runtime Behavior

When `staging.model === 'working-set'`:

- `chat()` can receive `workingSet`
- `promptedTurn()` can receive `workingSet`
- returned `ChatResult` may include:
  - `workingSet`
  - `workingSetSummary`
- `reviewWorkingSetDelta()` applies canonical accept/reject transitions for a stored delta
- managed mode can load and persist the working set automatically
- managed mode can call `reviewWorkingSet()` to persist a review decision without hand-editing JSON
- `commitWorkingSet()` commits accepted transport-layer deltas through app handlers

## Managed Storage Contract

Storage adapters can implement:

- `loadWorkingSet(conversationId)`
- `saveWorkingSet(conversationId, workingSet)`
- `clearWorkingSet(conversationId)`

If a persona enables `staging.model = 'working-set'`, managed mode expects these methods to exist.

## Review Transitions

Apps should not hand-mutate `reviewState` and `commitState` directly.

Use the SDK helper instead:

```ts
const next = reviewWorkingSetDelta(workingSet, {
  deltaId,
  decision: 'accept',
})
```

What the helper centralizes:

- accepting a pending transport delta moves it to `reviewState: accepted` and `commitState: ready`
- rejecting a transport delta removes it from the commit path
- accepting a failed transport delta can re-arm it for retry
- superseded or committed deltas cannot be reviewed again

In managed mode, use:

```ts
await managed.reviewWorkingSet({
  conversationId,
  deltaId,
  decision: 'reject',
})
```

## Migration Guidance

### Legacy batch vs working set

| Question | `legacy-batch` | `working-set` |
| --- | --- | --- |
| Default mental model | Proposal queue | One evolving draft |
| Best fit | Visible approval trays | Negotiation-heavy assistants |
| Meaning-layer changes | Often stay pending | Usually become current truth |
| Transport / side effects | Proposed or executed | Accepted, then explicitly committed |
| UI shape | Review queue | Conversational, inline, or structured |
| Risk if overused | Bureaucratic product feel | Hidden state without clear commit boundary |

### How to choose

Choose `working-set` when:

- accepted changes should feel like the current draft right away
- the user will refine accepted work across turns
- the app needs a clear split between conversational truth and external mutation
- the persona should speak from situations and intent, not from a proposal tray

Stay on `legacy-batch` when:

- the product genuinely wants a visible proposal queue
- review is the primary workflow rather than the assistant/user shaping one living draft
- the app does not need accepted-draft semantics yet

### Concrete flow

The intended working-set flow is:

1. The app paints the live scene.
2. The user asks for help or the app triggers a prompted turn.
3. The assistant emits meaning-layer deltas that become the current working draft.
4. If an outside-world action is appropriate, the assistant can also emit a transport-layer delta with `commitState: ready`.
5. The app decides when and how to expose that ready-to-commit action.
6. The app explicitly commits the transport delta through its own handler.
7. Stored history stays honest: the assistant does not narrate an external action as done until it really committed.

Notice what is *not* in that flow:

- no phrase trigger the user must say
- no requirement that the prompt script the workflow
- no second approval lane unless the app wants one

Move to working sets when:

- accepted changes should feel like the current draft
- user pushback should refine prior accepted work instead of starting a second review lane
- transport mutations need explicit commit

Stay on legacy batch when:

- the app really does want a visible proposal queue
- no accepted-draft semantics are needed yet

## Minimal Shape

```ts
const config = definePersona({
  ...baseConfig,
  staging: { model: 'working-set' },
  actions: {
    setReplyDraft: {
      description: 'Accept the current best reply draft for this thread.',
      schema: z.object({
        threadId: z.string(),
        draft: z.string(),
      }),
      layer: 'meaning',
      defaultReviewState: 'accepted',
      commitMode: 'not_required',
      targetKey: (params) => `thread:${params.threadId}:reply-draft`,
    },
    archiveThread: {
      description: 'Stage archiving this Gmail thread.',
      schema: z.object({
        threadId: z.string(),
      }),
      layer: 'transport',
      defaultReviewState: 'accepted',
      commitMode: 'explicit',
      targetKey: (params) => `thread:${params.threadId}:archive`,
    },
  },
})
```

## `targetKey` Cookbook

Use `targetKey` whenever the user and assistant should be shaping one current draft rather than accumulating duplicates.

Common patterns:

- reply draft per thread
  - `thread:${threadId}:reply-draft`
- singleton meal draft
  - `meal-draft`
- thread handling state
  - `thread:${threadId}:state`
- clause edit per clause id
  - `clause:${clauseId}:edit`

Rule of thumb:

- if a newer accepted delta should replace the older one, give them the same `targetKey`
- if the newer delta should coexist, use a different `targetKey`

## Review Affordance Is App-Owned

Working-set semantics do **not** imply one review UI.

The same accepted-by-default state model can support:

- `conversational`
  - nutrition-guide style: the draft mostly evolves through normal conversation
- `inline`
  - email-assistant style: the assistant brings one focused situation and a few explicit next moves
- `structured`
  - coaching-app style: the user reviews a dense set of changes in a dedicated surface

The SDK owns the state model.
The app owns how much of that state is visible, how it is edited, and when commit affordances appear.

That separation is important for future models.
As models improve, prompts should stay high-level and intent-first. The runtime and app boundary should carry the mechanics.

## Structured Draft Projections Are Valid

Not every app should render raw `WorkingDelta` rows directly.

Some products have richer domain-native review surfaces that are still governed by the same semantics:

- current draft vs rejected items
- supersession or replacement
- explicit commit to the outside world

A CEO coaching app is the clearest example.
Its debrief review is a structured projection over typed meeting-analysis objects, not a literal list of chat-emitted deltas.
That is still aligned with the working-set model as long as:

- accepted items feel like the current draft
- rejected items are clearly out of draft
- save remains the commit boundary

Use the runtime directly when it helps.
Use app-owned structured draft projections when the domain shape is richer than a simple delta list.

See:

- [ACTION_CONTRACTS.md](ACTION_CONTRACTS.md)
- [REFERENCE_APP.md](REFERENCE_APP.md)
- [STAGING_PROMOTION_TARGET.md](STAGING_PROMOTION_TARGET.md)
