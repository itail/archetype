import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { PersonaConfig } from '../src/types.js'
import { buildPromptedTurnPrompt } from '../src/core/prompt-builder.js'
import { auditPromptContent } from '../src/evals/prompt-content.js'

const baseConfig: PersonaConfig = {
  identity: {
    name: 'Coach',
    expertise: ['coaching'],
    relationship: 'thinking partner',
    northStar: 'clarity',
  },
  voice: { tone: 'balanced', style: 'quick', medium: 'desktop-panel' },
  provider: { name: 'mock', chat: async () => ({ text: '' }) },
}

describe('auditPromptContent', () => {
  it('flags known cross-domain example drift markers', () => {
    const result = auditPromptContent({
      prompt: 'Example with an entity mutation: {"message":"A lighter yogurt bowl makes sense here.","actions":[{"name":"crud","params":{"entity":"meal","id":"meal_2"}}]}',
    })

    expect(result.pass).toBe(false)
    expect(result.issues.map(issue => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('cross-domain example drift'),
    ]))
  })

  it('flags known boxing-smell phrases', () => {
    const result = auditPromptContent({
      prompt: 'Friendly and clear. Don\'t pad, don\'t truncate.\nBefore each response, silently review the full conversation.\nFrequency Rule: never repeat the same insight twice.\nYou understand the data — you\'re not a dashboard reading it out.',
    })

    expect(result.pass).toBe(true)
    expect(result.issues.map(issue => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('boxing or instruction-theater language'),
    ]))
  })

  it('flags repeated scaffold phrases', () => {
    const result = auditPromptContent({
      prompt: 'What is the single most impactful thing you could say right now?\nLater again: what is the single most impactful thing you could say right now?',
    })

    expect(result.pass).toBe(true)
    expect(result.issues.map(issue => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('repeats scaffold phrase'),
    ]))
  })

  it('flags split and nested workspace file surfaces', () => {
    const result = auditPromptContent({
      prompt: [
        '--- FILES ---',
        '- artifact/artifact/index.html',
        'artifact/ — writable, default for unprefixed file actions',
        '--- SPEC BUNDLE ---',
        '- spec/spec/brief.md',
      ].join('\n'),
    })

    expect(result.pass).toBe(false)
    expect(result.issues.map(issue => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('FILES and SPEC BUNDLE'),
      expect.stringContaining('artifact/artifact/'),
      expect.stringContaining('spec/spec/'),
      expect.stringContaining('hidden default workspace path alias'),
    ]))
  })

  it('flags duplicate editFile documentation in focus prompts', () => {
    const result = auditPromptContent({
      prompt: [
        '- editFile: Use when you can quote exact existing text.',
        'How the tools behave here:',
        "- editFile: each entry's oldText is matched against the file's current content.",
      ].join('\n'),
    })

    expect(result.pass).toBe(true)
    expect(result.issues.map(issue => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('documents editFile in both'),
    ]))
  })

  it('passes when the example entity matches declared entities', () => {
    const prompt = buildPromptedTurnPrompt({
      config: {
        ...baseConfig,
        entities: {
          thread: {
            schema: z.object({
              title: z.string(),
              status: z.enum(['active', 'done']).optional(),
            }),
            label: 'Thread',
            displayField: 'title',
          },
        },
      },
      input: { timezone: 'UTC', promptMode: 'conversation' },
      turnKind: 'proactive-conversation',
      intent: 'Offer one useful reflection.',
    })

    const result = auditPromptContent({
      prompt,
      declaredEntities: ['thread'],
    })

    expect(result.pass).toBe(true)
    expect(result.issues).toEqual([])
    expect(prompt).toContain('"entity":"thread"')
    expect(prompt).not.toContain('Recovery yogurt bowl')
  })
})
