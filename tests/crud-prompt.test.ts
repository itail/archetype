import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildEntitiesBlock } from '../src/core/crud-prompt.js'

describe('buildEntitiesBlock', () => {
  it('uses only required fields in the create example for optional-heavy entities', () => {
    const prompt = buildEntitiesBlock({
      task: {
        schema: z.object({
          title: z.string(),
          owner: z.string().optional(),
          due: z.string().optional(),
          notes: z.string().optional(),
          definitionOfDone: z.string().optional(),
          priority: z.enum(['low', 'medium', 'high']).optional(),
          status: z.enum(['open', 'done', 'canceled']).optional(),
        }),
        label: 'Task',
        displayField: 'title',
      },
    })

    expect(prompt).toContain('"params":"{\\"title\\":\\"<string>\\"}"')
    expect(prompt).toContain('add optional fields only when the situation genuinely calls for them')
    expect(prompt).not.toContain('\\"owner\\":\\"<string>\\"')
    expect(prompt).not.toContain('\\"definitionOfDone\\":\\"<string>\\"')
  })
})

describe('operations advertisement', () => {
  it('shows a restricted operations line and omits it for full-CRUD entities', () => {
    const block = buildEntitiesBlock({
      weight: { schema: z.object({ lbs: z.number() }), operations: ['create', 'delete'] },
      meal: { schema: z.object({ name: z.string() }) },
    })
    expect(block).toContain('operations: create, delete only')
    const mealSection = block.slice(block.indexOf('- meal'))
    expect(mealSection).not.toContain('operations:')
  })
})
