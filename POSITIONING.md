# Archetype Positioning

## What Archetype Is

Archetype is a runtime for AI expert roles in real products.

It is for building a nutritionist, trainer, coach, financial advisor, recruiter, chief of staff, or personal assistant that:

- feels like a real counterpart
- remembers what matters
- reasons from the live situation
- operates over shared product state
- stays inside a hard mutation boundary

## What Archetype Is Not

Archetype is not primarily:

- a workflow graph builder
- a manager-worker orchestration framework
- a generic "multi-agent team" toolkit
- a prompt patching engine that compensates for weak framing in code

Those systems can be useful. They are just solving a different problem.

## The Core Bet

Most agent failure does not come from the model needing more behavioral boxing.

It comes from:

- poor scenario framing
- incomplete world exposure
- weak action or entity contracts
- missing IDs, recipients, transitions, or operating surfaces

So Archetype takes a different posture:

- trust the model for judgment
- trust the runtime for mechanical enforcement

That means hard rules for:

- schemas
- permissions
- commit semantics
- auditability

and thinking room for:

- tone
- prioritization
- judgment
- relationship handling
- expert tradeoffs

## How Archetype Differs

### Versus LangGraph and orchestration-first frameworks

LangGraph-style systems are strongest when the main problem is durable control flow:

- branching
- retries
- loops
- routing
- explicit state transitions

Archetype is strongest when the main problem is:

- expert behavior
- relationship quality
- memory that compounds over time
- shared ledgers as truth
- bounded authority over real product state

In short:

- orchestration-first frameworks optimize the graph
- Archetype optimizes the role

### Versus CrewAI, AutoGen, and "teams of agents"

Those systems usually model agents as collaborators on a task.

Archetype models roles in an ongoing institution or product:

- durable identity
- memory scoped to the role
- shared ledgers
- channels
- authority boundaries

The difference is subtle but important:

- task-team systems ask "how do agents complete this job together?"
- Archetype asks "what role is this, what truth does it share with others, and what authority does it have?"

### Versus Letta and memory-first agent systems

Letta is the closest adjacent category because it takes state and memory seriously.

Archetype's narrower thesis is that memory alone is not the primitive.
The primitive is an expert role in relationship with a human, later with other roles, operating over shared ledgers behind a mutation firewall.

So Archetype is less about generic stateful agents and more about:

- trustworthy expert products
- scenario-first prompting
- ledger-centric product design
- institution-shaped multi-role systems

## Why This Matters

The near-term opportunity is not abstract AGI orchestration.

It is building AI experts that already create meaningful value for real people:

- better nutrition guidance
- better fitness coaching
- better personal support
- better financial guidance
- better operational leverage

The longer-term opportunity is to let humans and AI participate in the same organizational model:

- roles
- ledgers
- channels
- authority
- governance

with as much governance as possible represented by roles and institutions, and only the minimum necessary kept as hard platform invariants.

## What To Build Versus Borrow

Archetype should build its own thesis where it is differentiated:

- role runtime
- memory + judgment model
- scenario-first prompt contract
- ledger and working-set semantics
- role-to-role consultation
- institution-shaped governance patterns

Archetype should borrow or integrate existing standards where they are already good enough:

- MCP for tools and context
- A2A-style protocols for inter-agent interoperability
- standard auth, permissions, tracing, and audit infrastructure

The goal is not to rebuild the whole stack.
The goal is to own the layer that makes AI experts and institutions actually feel believable, trustworthy, and useful.
