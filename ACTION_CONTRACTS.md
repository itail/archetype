# Action Contract Cookbook

Good action contracts do more for reliability than clever repair logic.

The core rule:

- prefer shapes that match the domain naturally
- avoid forcing everything through a vague shared update bag

## Entity CRUD Contracts

When you declare entities in your persona config, the SDK auto-generates create/update/delete actions for each entity. This is the primary action pattern — most personas should model all domain operations as entities and leave `actions: {}` empty.

### How it works

1. **Declare entities** in `PersonaConfig.entities` with a Zod schema, label, and displayField.
2. The SDK generates the prompt instructions and response schema automatically. The AI returns `crudActions` in its response.
3. Each `CrudAction` has: `operation` (`'create'` | `'update'` | `'delete'`), `entity` (the entity name), `id` (string), and `params` (validated against the entity schema).
4. The app handles entity changes through `commitCrud` with a `CrudEntityHandler` per entity:

```ts
import { commitCrud, type CrudEntityHandler } from 'archetype'

const taskHandler: CrudEntityHandler = {
  create: async (id, params) => { /* persist */ return { success: true } },
  update: async (id, params) => { /* persist */ return { success: true } },
  delete: async (id) => { /* persist */ return { success: true } },
}

await commitCrud(result.crudActions, { task: taskHandler })
```

Entity schemas define the contract; the SDK validates params against the Zod schemas before they reach your handlers. If validation fails, the SDK retries with the LLM once — the same repair loop used for named actions.

Named actions (`actions` config) are only for the rare truly non-entity operations — things like sending an email that don't map to create/update/delete on a domain object.

## Prefer Direct Update Shapes

Better:

```ts
updateThread: z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['active', 'at_risk', 'stuck', 'parked', 'done']).optional(),
})
```

Worse:

```ts
updateThread: z.object({
  id: z.string(),
  field: z.enum(['title', 'description', 'status']),
  value: z.string(),
})
```

Why direct fields usually win:

- they match how the model already thinks
- they reduce schema ambiguity
- they support multi-field updates in one action
- they make UI labels and debug output cleaner

## When `field/value` Is Still Acceptable

Use it when:

- the entity truly behaves like a key/value record
- the update surface is tiny
- backward compatibility matters and you do not want a bigger migration

Even then, prefer normalizing it into a richer internal representation at the boundary.

## Null / Unaffiliate Semantics

If a field can be cleared, define that explicitly.

Example:

```ts
updateCue: z.object({
  id: z.string(),
  principleId: z.string().nullable().optional(),
})
```

Or document the compatibility rule clearly:

- empty string means unaffiliate
- server normalizes `""` to `null`

Do not leave that implicit.

## Multi-Action Turns

A persona should be able to make more than one valid change in a single turn when the user clearly asked for it.

Good:

- `actions: [{ name, params }, { name, params }]`

Bad:

- one giant mixed params bag
- one action that tries to encode many unrelated operations

## Keep Action Descriptions Load-Bearing

Action descriptions are not comments. They are part of the contract the model sees.

Good description:

- says when the action is appropriate
- explains the update-vs-create judgment
- reflects product intent

Weak description:

- repeats the name
- overexplains the schema mechanically
- encodes fear-driven micromanagement

## Working-Set Metadata

If a persona uses `staging.model = 'working-set'`, action metadata becomes part of the contract too.

The important fields are:

- `layer`
- `defaultReviewState`
- `commitMode`
- `targetKey`

Recommended defaults:

- meaning-layer draft or classification actions:
  - `layer: 'meaning'`
  - `defaultReviewState: 'accepted'`
  - `commitMode: 'not_required'`
- transport or side-effect actions:
  - `layer: 'transport'`
  - `defaultReviewState: 'accepted'`
  - `commitMode: 'explicit'`

Use `targetKey` when newer accepted deltas should supersede older active ones.

Examples:

- one reply draft per thread
- one meal draft at a time
- one current handling state per situation

Useful patterns:

| Domain shape | Good `targetKey` |
| --- | --- |
| reply draft per thread | `thread:${threadId}:reply-draft` |
| singleton meal draft | `meal-draft` |
| current thread handling state | `thread:${threadId}:state` |
| clause edit per clause | `clause:${clauseId}:edit` |

Without a good `targetKey`, negotiation-heavy products get duplicate drafts instead of one evolving working truth.

## Backward Compatibility Pattern

If you need to migrate from an older shape:

1. define the cleaner prompt-facing contract
2. accept the old shape temporarily
3. normalize both into one internal representation
4. store and render from the normalized representation

That keeps compatibility local instead of letting legacy shapes leak across the whole app.

## Smell Tests

Your contract probably needs work if:

- two different docs describe two different param shapes
- the UI and the server interpret the same action differently
- the model often returns "almost right" updates
- one update action can only touch one field even when the domain clearly wants more
- debug output is hard to read because the contract is too generic

## Best Pattern

- action schema is explicit
- prompt examples match the schema exactly
- update actions use direct fields when practical
- legacy compatibility is normalized at the boundary
- storage/debug/history use the normalized shape
