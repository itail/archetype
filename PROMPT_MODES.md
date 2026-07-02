# PROMPT_MODES.md

Archetype has two prompt modes:

- `conversation`
- `operational`

This split exists because the SDK serves two different kinds of turns.

## Conversation mode

Use when the persona is talking to a person.

This mode keeps the playbook's conversational scaffold:

- relationship framing
- voice/medium phrasing
- cold-start relationship guidance
- user-message-oriented history hygiene
- follow-up guidance
- momentum / come-back framing

This is the right default for normal chat turns.

## Operational mode

Use when the turn is app-initiated or institution-initiated and the persona is making a move inside a system.

This mode removes chat-first framing by default and replaces it with operational continuity:

- no relational preamble
- no momentum / come-back test
- no user-relationship cold-start copy
- no user-message-specific history framing
- no follow-up guidance by default
- stricter emphasis that action/entity contracts are mechanical truth

Operational mode is the right fit for:

- `promptedTurn()` initiative turns
- institution/runtime turns in Foundry
- wake-up style turns where nobody sent a fresh message

## Design principle

Do not solve operational-turn failures by adding corrective prose aimed at a "mediocre employee."
Instead:

1. choose the correct prompt mode
2. paint the live scene honestly
3. expose the exact operating surface
4. make action/entity contracts literal and visible

Another way to say this:

- do not box the model after failure
- do not add fuzzy recovery code before checking the prompt actually exposed the needed world
- do not summarize actionable objects only as prose when the role needs concrete handles

The common failure pattern we want to prevent is:

1. app builds an Archetype persona
2. the role cannot act because the operating surface is incomplete
3. a coding agent adds corrective prompt prose or post-hoc coercion
4. the role starts behaving like a boxed mediocre operator
5. the user concludes Archetype itself is weak

That is the wrong loop.

The preferred loop is:

1. inspect the exact provider-boundary prompt
2. verify the turn is in the right prompt mode
3. verify the action/entity contract is present exactly once
4. verify the real IDs / recipients / transitions are visible
5. only then judge the model's behavior

## Action contract guidance

Action descriptions should do two jobs:

- explain when an action is for
- document the exact executable contract

That means the prompt should show both:

- behavioral purpose
- API reference

If an action needs an identifier, the prompt must expose real identifiers or an explicit retrieval path.
If an action needs an enum, the prompt must expose valid values in-world.
If an action needs a recipient, the prompt must expose a directory.

This is not hypothetical. A real production failure in a nutrition-coaching app on Archetype came from exactly this class of miss:

- the role was expected to update writable entities
- the prompt did not expose the real entity IDs
- the trace exception caught the miss

Treat that as an operational-contract bug, not as a model-quality mystery.

Schema validation after the fact is not enough.
The model needs a visible operational surface before the fact.

## Archetype vs app

To reduce cross-app failure risk, keep this split sharp.

### Archetype should own

- conversation vs operational prompt scaffolds
- canonical action API contract rendering
- canonical entity CRUD contract rendering
- provider-boundary prompt construction
- prompt/trace audit helpers

### Apps should own

- the live scene
- the real operating objects
- the real IDs / recipients / enum values
- whether the full surface is in prompt or behind retrieval

If an app writes large custom API prose blocks that duplicate Archetype's contract block, it is likely rebuilding the SDK in the prompt and increasing drift risk.

## Reference usage

Use `chat()` when a person is talking to the persona:

```ts
const result = await persona.chat({
  message: 'I had the same roadmap conversation with my VP again.',
  history,
  context,
  memories,
  userIdentity: 'Alex, CEO',
})
```

Use `promptedTurn()` when nobody sent a fresh message and the persona is waking up into live state:

```ts
const result = await persona.promptedTurn({
  intent: 'Read the institution and decide the next move.',
  context: {
    roleDirectory: [
      { roleId: 'role-ceo-1', title: 'CEO' },
      { roleId: 'role-ops-1', title: 'Ops Lead' },
    ],
    externalThreads: [
      'threadId: thread-123 | counterparty: North Clinic | status: waiting-on-company | validNextStatus: waiting-on-counterparty | scheduled | closed',
    ],
  },
})
```

Operational turns work best when apps expose the real operating surface directly:

- if an action needs an id, include the id in context
- if an action needs a recipient, include a role or user directory
- if an action needs a state transition, include the current state and valid next states
- if the surface is too large to inline, include an explicit retrieval path rather than hiding the objects
- if transport correctness matters, end the prompt with an explicit raw-JSON transport contract and verify the provider-boundary request actually includes it

## Regression safety net

Archetype exports `auditOperationalPromptContract()` for app-level regression tests.

Use it to assert that an operational turn:

- was actually built in `operational` mode
- contains the canonical SDK-owned action API contract
- does not leak conversation scaffold
- exposes the ids / enums / recipients the actions need
- produces a clean trace without unknown actions or unexpected repair

Apply the same audit to newly spawned roles on their first wake-up turn.
If one role creates another role, the new role's first operational prompt should pass the same contract checks before you blame the spawned role itself.

## Reference checklist for coding agents

Before "fixing the model," check these first:

- Is this really a `conversation` turn or should it be `operational`?
- Does the prompt expose the exact real objects the role can act on?
- If an action needs an ID, is that ID present?
- If an action needs a recipient, is the directory present?
- If an action needs a state transition, are current and valid next states present?
- Is the canonical action/entity contract emitted exactly once?
- Is the coding agent about to add corrective prose for a failure that is really a missing-world problem?

If the answer to any of the first six is "no", fix the operating surface before adding more instruction text.
