import { describe, it, expect, vi } from 'vitest'
import { definePersona } from '../src/index.js'
import type { LLMProvider, LLMProviderRequest } from '../src/types.js'

// ─── Mock Provider that captures requests ────────────────────────────────────

function createCapturingProvider(): { provider: LLMProvider; getLastRequest: () => LLMProviderRequest } {
  let lastRequest: LLMProviderRequest | null = null

  const provider: LLMProvider = {
    name: 'mock-capture',
    chat: vi.fn().mockImplementation(async (request: LLMProviderRequest) => {
      lastRequest = request
      return { text: JSON.stringify({ message: 'Got it.', actions: [] }) }
    }),
  }

  return {
    provider,
    getLastRequest: () => {
      if (!lastRequest) throw new Error('No request captured')
      return lastRequest
    },
  }
}

function createPersona(provider: LLMProvider) {
  return definePersona({
    identity: {
      name: 'TestBot',
      expertise: ['testing'],
      relationship: 'test helper',
      northStar: 'test coverage',
    },
    voice: { tone: 'direct', style: 'quick' },
    provider,
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('multimodal attachments', () => {
  it('passes attachments through to LLMProviderRequest', async () => {
    const { provider, getLastRequest } = createCapturingProvider()
    const persona = createPersona(provider)

    await persona.chat({
      message: 'What is in this image?',
      attachments: [
        { type: 'image', mimeType: 'image/jpeg', data: 'base64data123' },
      ],
    })

    const request = getLastRequest()
    expect(request.attachments).toHaveLength(1)
    expect(request.attachments![0]).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'base64data123',
    })
  })

  it('passes multiple attachments', async () => {
    const { provider, getLastRequest } = createCapturingProvider()
    const persona = createPersona(provider)

    await persona.chat({
      message: 'Compare these images',
      attachments: [
        { type: 'image', mimeType: 'image/jpeg', data: 'img1data' },
        { type: 'image', mimeType: 'image/png', data: 'img2data' },
      ],
    })

    const request = getLastRequest()
    expect(request.attachments).toHaveLength(2)
    expect(request.attachments![0].mimeType).toBe('image/jpeg')
    expect(request.attachments![1].mimeType).toBe('image/png')
  })

  it('sends no attachments field when none provided', async () => {
    const { provider, getLastRequest } = createCapturingProvider()
    const persona = createPersona(provider)

    await persona.chat({ message: 'Hello' })

    const request = getLastRequest()
    expect(request.attachments).toBeUndefined()
  })

  it('sends undefined attachments when empty array provided', async () => {
    const { provider, getLastRequest } = createCapturingProvider()
    const persona = createPersona(provider)

    await persona.chat({ message: 'Hello', attachments: [] })

    const request = getLastRequest()
    // Empty array is passed through (provider handles as no-op)
    expect(request.attachments).toEqual([])
  })
})
