# Reference App Walkthrough

This is the recommended app shape for teams using Archetype in a real product.

It is intentionally a walkthrough, not a fake app with hand-wavy placeholders.

Use the existing runnable examples for the smallest possible setup:

- [chief-of-staff/index.ts](examples/chief-of-staff/index.ts)
- [fitness/index.ts](examples/fitness/index.ts)
- [working-set-assistant/index.ts](examples/working-set-assistant/index.ts)
- [working-set-nutrition/index.ts](examples/working-set-nutrition/index.ts)

Use this guide when you are moving from "the SDK works" to "the product feels right."

## 1. Define the persona

Start with a starter template or your own config.

Keep the prompt focused on:

- relationship
- north star
- tone
- action descriptions
- memory policy

Let the live scenario do the rest.

## 2. Feed a rich scenario every turn

Your app should gather:

- recent messages
- current domain context
- memories
- timezone
- attachments if needed

That is the real steering wheel.

If the app starts the turn itself, use `promptedTurn()` and classify it deliberately:

- `turnKind: 'proactive-conversation'` for a real user-facing check-in or nudge
- `turnKind: 'operational'` for waking the assistant into a queue, system, or institution

Do not fake a user message just to get a response, and do not let app-initiated chat accidentally inherit an operational scaffold.

When reviewing prompt quality, inspect the exact provider-boundary request with:

- `buildChatLLMRequest(config, input)`
- `buildPromptedTurnLLMRequest(config, input)`

That gives you the actual `systemPrompt`, `history`, `message`, and response schema the model sees.

## 3. Execute actions in the app

Archetype returns typed actions.

Your app should:

- validate them
- execute them
- normalize true invariants
- store executed results

If the persona uses `staging.model = 'working-set'`, add one more layer:

- load the current working set before the turn
- let meaning-layer deltas become the current draft
- keep transport-layer deltas in `ready` state until explicit commit
- if the product exposes accept/reject controls, apply them through `reviewWorkingSetDelta()` or managed `reviewWorkingSet()`
- persist the working set after the turn
- commit external actions through app-owned handlers only

That keeps the assistant honest. The conversation can move forward on the current draft without pretending that the outside world already changed.

The useful mental split is:

- prompt = judgment
- working set = current draft
- app commit = actual side effect

Do not teach the model workflow incantations if the runtime can carry that responsibility for you.

## 4. Store assistant history honestly

Only store executed actions back into assistant history.

That keeps future turns grounded in reality and avoids clanky self-narration.

## 5. Render messages as product UI, not raw strings

A strong app usually includes:

- markdown rendering
- follow-up chips
- a compact debug view in dev/admin contexts
- clear distinction between visible reply and hidden operation history

## 6. Test both mechanics and feel

Minimum recommendation:

- one deterministic multi-turn eval for domain behavior
- one live eval for "does this still sound human and useful?"

Also add one transport-hygiene gate for important turns:

- `repairAttempted === false`
- no parser errors
- no invalid or unknown actions
- no raw top-level `crudActions` drift

## Common App Patterns

- Nutrition guide pattern:
  conversational-first draft shaping + light inline controls + explicit logging commit

- Coaching app pattern:
  structured review surface + accepted working draft + explicit save boundary

- Email assistant pattern:
  inline assistant-led review + transport-backed meaning/commit split

- Fitness coach pattern:
  managed coach path + thin domain normalization around workout semantics
