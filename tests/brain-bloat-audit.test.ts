import { describe, expect, it } from 'vitest'
import { auditBrainBloat } from '../src/evals/brain-bloat.js'

describe('auditBrainBloat', () => {
  it('passes a compact brain', () => {
    const result = auditBrainBloat({
      markdown: `---
id: compact-brain
---

## Voice Formatting
Keep formatting light.

## Methodology
- Notice what is true now.
- Prefer the smallest real move.

## Action Protocol
- Use declared actions for external changes.

## Greeting Guidelines
- Be warm.
`,
    })

    expect(result.pass).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('fails brains whose sections blow past structural budgets', () => {
    const longSentence = 'This is a very long sentence about how to think correctly under every possible circumstance. '
    const methodology = longSentence.repeat(20)
    const formatting = 'Formatting should be vivid and expressive without ever losing clarity. '.repeat(6)

    const result = auditBrainBloat({
      markdown: `---
id: bloated-brain
---

## Voice Formatting
${formatting}

## Methodology
${methodology}

## Greeting Guidelines
- Ask strong questions.
`,
    })

    expect(result.pass).toBe(false)
    expect(result.issues.map(issue => issue.kind)).toEqual(expect.arrayContaining([
      'section-size',
    ]))
  })

  it('warns on repeated long lines across sections', () => {
    const repeated = '- Prefer the smallest real move that changes reality instead of explaining why you could have acted.'
    const result = auditBrainBloat({
      markdown: `---
id: repeated-brain
---

## Methodology
${repeated}

## Greeting Guidelines
${repeated}
`,
    })

    expect(result.pass).toBe(true)
    expect(result.issues.map(issue => issue.kind)).toContain('repeated-line')
  })

  it('warns on very long methodology paragraphs even if the section still passes size budget', () => {
    const paragraph = 'This paragraph keeps going in a way that turns a brain into prose documentation rather than a tight operational scaffold, and it does so without line breaks, bullets, or any compression strategy whatsoever. '.repeat(3)
    const result = auditBrainBloat({
      markdown: `---
id: paragraph-brain
---

## Methodology
${paragraph}
`,
      options: {
        maxTotalChars: 5000,
        sectionCharBudgets: { methodology: 2000 },
      },
    })

    expect(result.pass).toBe(true)
    expect(result.issues.map(issue => issue.kind)).toContain('long-paragraph')
  })

  it('fails concise sections that read like product mechanics documentation', () => {
    const result = auditBrainBloat({
      markdown: `---
id: leaky-brain
---

## Action Protocol
- Use the task entity for durable work.
- Use the id shown in the TASK RECORD context block for updates.
- If the old instructions no longer apply, clear them through CRUD with recipe: null.
`,
    })

    expect(result.pass).toBe(false)
    expect(result.issues.map(issue => issue.kind)).toContain('implementation-leakage')
  })

  it('fails on total brain size even when no single section crosses its budget', () => {
    const section = '- Keep it concrete.\n'.repeat(20)
    const result = auditBrainBloat({
      markdown: `---
id: too-much-total
---

## Methodology
${section}

## Action Protocol
${section}

## Greeting Guidelines
${section}

## Retrospective Guidelines
${section}
`,
      options: {
        maxTotalChars: 900,
        sectionCharBudgets: {
          methodology: 1000,
          'action-protocol': 1000,
          'greeting-guidelines': 1000,
          'retrospective-guidelines': 1000,
        },
      },
    })

    expect(result.pass).toBe(false)
    expect(result.issues.map(issue => issue.kind)).toContain('total-brain-size')
  })
})
