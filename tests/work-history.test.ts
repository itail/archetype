import { describe, expect, it } from 'vitest'
import { renderWorkHistoryEntries } from '../src/index.js'

describe('work history rendering', () => {
  it('renders chronological self/action/world entries with light provenance', () => {
    const rendered = renderWorkHistoryEntries([
      { turn: 1, source: 'self', text: 'I will update the index.' },
      { turn: 1, source: 'action', text: 'editFile index.md failed: oldText not found.' },
      { turn: 2, source: 'world', text: 'Requirement change introduced.' },
    ], { currentTurn: 2 })

    expect(rendered).toEqual([
      'turn 1 · self: I will update the index.',
      'turn 1 · action: editFile index.md failed: oldText not found.',
      'turn 2 · world: Requirement change introduced.',
    ])
  })

  it('decays large action results into recovery tombstones after their result window', () => {
    const rendered = renderWorkHistoryEntries([
      {
        turn: 1,
        source: 'action',
        text: 'readFile brief.md\ncontent:\nfull body',
        resultTurns: 1,
        staleText: '<readFile result for brief.md no longer carried; read again only if exact contents are needed>',
      },
    ], { currentTurn: 3 })

    expect(rendered[0]).toContain('read again only if exact contents are needed')
    expect(rendered[0]).not.toContain('full body')
  })

  it('keeps small read worksets visible across several future turns', () => {
    const rendered = renderWorkHistoryEntries([
      {
        turn: 1,
        source: 'action',
        text: 'readFile spec.md\ncontent:\n# Spec\nkeep this current workset visible',
        resultTurns: 4,
        staleText: '<readFile result for spec.md no longer carried; read again only if exact contents are needed>',
      },
    ], { currentTurn: 5 })

    expect(rendered[0]).toContain('# Spec')
    expect(rendered[0]).not.toContain('no longer carried')
  })

  it('preserves multiline action results while they are visible', () => {
    const rendered = renderWorkHistoryEntries([
      {
        turn: 2,
        source: 'action',
        text: 'readFile spec.md\ncontent:\n# Spec\n  - indented line',
      },
    ], { currentTurn: 2 })

    expect(rendered[0]).toContain('readFile spec.md\ncontent:\n# Spec\n  - indented line')
  })
})
