import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DOC_PATH = path.resolve(
  process.cwd(),
  'docs',
  'ARCHETYPE_LOCKED_CONTINUITY_INVARIANTS_2026-04-28.md',
)

function readDoc() {
  return fs.readFileSync(DOC_PATH, 'utf8')
}

describe('locked continuity invariants', () => {
  it('requires explicit human approval before any locked invariant is reopened', () => {
    const doc = readDoc()

    expect(doc).toContain('Invariants Require Explicit Human Approval To Reopen')
    expect(doc).toContain('Evidence is not permission to rewrite one.')
    expect(doc).toContain('stop implementation')
    expect(doc).toContain('ask the human owner for explicit approval')
    expect(doc).toContain('Forbidden without explicit approval')
    expect(doc).toContain('changing a test that enforces a locked invariant')
    expect(doc).toContain('changing an action schema or default tool surface')
    expect(doc).toContain('"the evidence is strong enough"')
  })

  it('documents Archetype-owned outcome continuity instead of raw action replay', () => {
    const doc = readDoc()

    expect(doc).toContain('Archetype Owns Action Continuity')
    expect(doc).toContain('Future turns must not receive raw action payloads as normal model history.')
    expect(doc).toContain('compact action narration')
    expect(doc).toContain('factual action outcome')
    expect(doc).toContain('Bulk mutations summarize the result')
    expect(doc).toContain('Attempted actions appear as compact natural-language action narration')
    expect(doc).toContain('raw action JSON or provider tool-call dumps')
    expect(doc).toContain('future agent understands what it tried')
    expect(doc).toContain('why the outcome matters')
    expect(doc).toContain('It must not preserve raw params')
    expect(doc).toContain('large file bodies')
    expect(doc).toContain('obsolete action schemas')
    expect(doc).toContain('Raw action calls, params, provider payloads, and large bodies belong in audit')
    expect(doc).toContain('not future prompt history')
  })

  it('locks native provider tool calls as transport detail, not product architecture', () => {
    const doc = readDoc()

    expect(doc).toContain('Do Not Switch To Native Provider Tool History')
    expect(doc).toContain('Native provider tool calls can be useful as a transport detail')
    expect(doc).toContain('they do not own Archetype continuity')
    expect(doc).toContain('If native function calling is used internally')
    expect(doc).toContain('outcome-continuity contract')
  })

  it('locks whole-file writes and targeted patches as distinct builder edit concepts', () => {
    const doc = readDoc()

    expect(doc).toContain('Do Not Drift File Editing Concepts')
    expect(doc).toContain('The current builder file mutation concept is two simple expert moves')
    expect(doc).toContain('`writeFile` creates or replaces a whole file')
    expect(doc).toContain('`applyPatch` makes targeted edits')
    expect(doc).toContain('Both actions must return compact factual outcomes')
    expect(doc).toContain('When `applyPatch` fails, the outcome explains the failed editing contract')
    expect(doc).toContain('read the affected files')
    expect(doc).toContain('if exact current contents are not already in prompt')
    expect(doc).toContain('Do not collapse these tools back into one vague "edit" primitive')
  })

  it('locks source files as visible file-tree facts rather than hidden work-item contents', () => {
    const doc = readDoc()

    expect(doc).toContain('Source Files Are Visible; Contents Are Chosen By The Persona')
    expect(doc).toContain('FILES shows relevant source files from turn one')
    expect(doc).toContain('path, mutability, purpose, line count, and byte count')
    expect(doc).toContain('does not embed full source contents')
    expect(doc).toContain('does not convert source material into a hidden WORK ITEM')
    expect(doc).toContain('the PM chose `readFile`')
  })

  it('locks persona-authored work state rather than host-authored hidden work items', () => {
    const doc = readDoc()

    expect(doc).toContain('The Host Does Not Author The Work Item')
    expect(doc).toContain('The persona creates or updates durable work state')
    expect(doc).toContain('The host persists and renders that state truthfully')
    expect(doc).toContain('must not secretly author a stronger work item')
    expect(doc).toContain('future operating context')
    expect(doc).toContain('expert anchor')
    expect(doc).toContain('layered on top of source truth')
    expect(doc).toContain('expert judgment lens')
    expect(doc).toContain('work or product spine')
    expect(doc).toContain('manageable parts')
    expect(doc).toContain("not a hidden handoff that narrows")
    expect(doc).toContain('The persona writes it')
    expect(doc).toContain('A good PM focus work item can anchor player promise')
    expect(doc).toContain('A good builder focus work item can be implementation-shaped')
  })

  it('locks mounted workspaces to one canonical visible path world', () => {
    const doc = readDoc()

    expect(doc).toContain('Workspace Paths Have One Canonical Visible Name')
    expect(doc).toContain('Do not give the persona two names for the same durable file')
    expect(doc).toContain('every file has exactly one canonical visible path')
    expect(doc).toContain('what appears in FILES')
    expect(doc).toContain('first-party file actions')
    expect(doc).toContain('arbitrary sandbox commands')
    expect(doc).toContain('fixed sandbox preset tools')
    expect(doc).toContain('Mounted file actions do not silently treat `index.html` as an alias')
    expect(doc).toContain('cwd that contains the visible')
    expect(doc).toContain('their path world must not silently drift away from FILES')
    expect(doc).toContain('The split was the bug')
  })

  it('requires PI evidence to be reconciled with invariants before recommendations', () => {
    const doc = readDoc()

    expect(doc).toContain('PI Is A Benchmark, Not The Architecture')
    expect(doc).toContain('Do not conclude "use native tool calls."')
    expect(doc).toContain('the lesson is diagnostic action')
    expect(doc).toContain('keep `writeFile` as a first-class')
    expect(doc).toContain('Do not conclude "hard-code a better work item."')
    expect(doc).toContain('reconciled with locked invariants')
  })

  it('records the 9/10 PM-builder recovery trace as locked evidence, not permission to drift', () => {
    const doc = readDoc()

    expect(doc).toContain('PM-Builder 9/10 Recovery Trace')
    expect(doc).toContain('source files were visible in FILES from turn one')
    expect(doc).toContain('both PM and builder focus mode used persona-authored work items')
    expect(doc).toContain('Do not treat a future lower score as permission to undo these fixes')
  })

  it('locks benchmark runs as observation rather than live repair sessions', () => {
    const doc = readDoc()

    expect(doc).toContain('Benchmarks Are Observation, Not Live Repair')
    expect(doc).toContain('A benchmark run is for observing the real agent/harness system')
    expect(doc).toContain('not an interactive patch session')
    expect(doc).toContain('do not change prompts, action docs, tool behavior')
    expect(doc).toContain('Let the run finish')
    expect(doc).toContain('diagnose from the earliest')
    expect(doc).toContain('weak turn')
    expect(doc).toContain('invalid')
    expect(doc).toContain('run mechanical failure')
    expect(doc).toContain('retry handling corrupts the original prompt')
    expect(doc).toContain('Everything else is evidence, not permission to repair the run in place.')
    expect(doc).toContain('agent judgment failure that should be scored as-is')
    expect(doc).toContain('small repro test')
    expect(doc).toContain('Do not use one lower benchmark score to replace')
    expect(doc).toContain('hide `finishAttempt`')
    expect(doc).toContain('add completion vetoes')
  })
})
