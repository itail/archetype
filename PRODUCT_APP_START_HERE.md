# Product App Start Here

If you are building a real product app with Archetype, start here.

## Default Path

Use this stack by default:

- `definePersona()`
- `withStorage()`
- `managed.chat()` and `managed.promptedTurn()`
- `entities`
- `commitCrud()`

This is the shortest clean path for apps with:

- persistence
- conversation history
- memories
- traces
- working-set state

## Default Modeling Rule

Model domain operations as CRUD entities first.

Use:

- `entities`
- `result.crudActions`
- `commitCrud()`

Keep:

- `actions: {}`

unless a truly non-entity operation exists, such as sending an email or triggering an external workflow.

## What Managed Mode Owns

In Layer 2 managed mode, let the SDK own:

- conversation lifecycle
- message persistence
- memory loading
- memory prompt selection and budget trimming
- memory CRUD
- trace persistence
- retrospection
- working-set persistence

Your app should usually own:

- rendering
- domain storage
- `commitCrud()` handlers
- approval and commit UI
- true domain invariants

Important nuance:

- `managed.chat()` and `managed.promptedTurn()` should be equivalent in statefulness
- the difference is only whether a user message initiated the turn
- proactive or app-initiated turns should not cause the app to reimplement memory handling locally

## Storage Adapter Contract

Treat the storage adapter as a persistence layer, not a memory policy layer.

The adapter should do:

- `saveMemory`
- `updateMemory`
- `deleteMemory`
- `loadMemories`
- preserve whatever metadata Archetype gives it

The adapter should not do:

- final prompt cropping
- custom salience rules
- flattening `pinned`, `source`, `stability`, or `contextHint`
- app-specific memory rewriting before the SDK sees the records

Reason:

- Archetype should decide which memories matter for the turn
- the app should faithfully store and return candidate memories

## Smells You Are Rebuilding Layer 2

- manually loading and trimming history every turn
- manually saving assistant messages every turn
- manually handling memory CRUD in app code
- custom loops for entity dispatch instead of `commitCrud()`
- conversion bridges between named actions and CRUD
- patching model omissions in code instead of improving the scenario or entity contract

If you see those patterns, stop and check whether Layer 2 already has the shape you need.

## When Layer 1 Is Actually Right

Use Layer 1 directly when:

- another control plane already owns persistence and lifecycle
- the integration is intentionally stateless
- Archetype is embedded as a specialized runtime inside a larger orchestrated system

Examples:

- embedding Archetype as a specialized runtime behind an external orchestration platform
- judges and eval harnesses
- specialist services behind another platform

## What To Read Next

- [README.md](README.md)
- [REFERENCE_APP.md](REFERENCE_APP.md)
- [WORKING_SET.md](WORKING_SET.md)
