import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveFallbackChain, isRetryable } from '../src/providers/gemini.js'

describe('resolveFallbackChain', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv.GEMINI_FALLBACK_MODELS = process.env.GEMINI_FALLBACK_MODELS
    savedEnv.GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL
    delete process.env.GEMINI_FALLBACK_MODELS
    delete process.env.GEMINI_FALLBACK_MODEL
  })

  afterEach(() => {
    if (savedEnv.GEMINI_FALLBACK_MODELS === undefined) delete process.env.GEMINI_FALLBACK_MODELS
    else process.env.GEMINI_FALLBACK_MODELS = savedEnv.GEMINI_FALLBACK_MODELS
    if (savedEnv.GEMINI_FALLBACK_MODEL === undefined) delete process.env.GEMINI_FALLBACK_MODEL
    else process.env.GEMINI_FALLBACK_MODEL = savedEnv.GEMINI_FALLBACK_MODEL
  })

  it('uses the default Gemini fallback ladder with no config and no env vars', () => {
    expect(resolveFallbackChain('primary')).toEqual(['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'])
  })

  it('uses fallbackModels from config', () => {
    expect(resolveFallbackChain('primary', { fallbackModels: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  it('wraps single fallbackModel into array', () => {
    expect(resolveFallbackChain('primary', { fallbackModel: 'a' })).toEqual(['a'])
  })

  it('fallbackModels takes precedence over fallbackModel', () => {
    expect(resolveFallbackChain('primary', { fallbackModels: ['x'], fallbackModel: 'y' })).toEqual(['x'])
  })

  it('parses GEMINI_FALLBACK_MODELS env var (comma-separated)', () => {
    process.env.GEMINI_FALLBACK_MODELS = 'a, b , c'
    expect(resolveFallbackChain('primary')).toEqual(['a', 'b', 'c'])
  })

  it('uses GEMINI_FALLBACK_MODEL env var as last resort', () => {
    process.env.GEMINI_FALLBACK_MODEL = 'z'
    expect(resolveFallbackChain('primary')).toEqual(['z'])
  })

  it('config takes precedence over env vars', () => {
    process.env.GEMINI_FALLBACK_MODELS = 'env-a,env-b'
    expect(resolveFallbackChain('primary', { fallbackModel: 'cfg' })).toEqual(['cfg'])
  })

  it('excludes primary model from chain', () => {
    expect(resolveFallbackChain('x', { fallbackModels: ['x', 'y', 'z'] })).toEqual(['y', 'z'])
  })

  it('removes duplicates', () => {
    expect(resolveFallbackChain('primary', { fallbackModels: ['a', 'b', 'a', 'c', 'b'] })).toEqual(['a', 'b', 'c'])
  })

  it('treats an explicit empty fallbackModels array as no fallback', () => {
    process.env.GEMINI_FALLBACK_MODELS = 'env-a'
    expect(resolveFallbackChain('primary', { fallbackModels: [] })).toEqual([])
  })
})

describe('isRetryable', () => {
  it.each([
    'Gemini API error (503): overloaded',
    'Request timed out after 45000ms',
    'Gemini API error (429): rate limited',
  ])('classifies known transient errors as retryable: %s', (msg) => {
    expect(isRetryable(new Error(msg))).toBe(true)
  })

  it('classifies empty responses as retryable so the fallback ladder engages', () => {
    // SAFETY / MAX_TOKENS / MALFORMED responses are flaky per-model, per-attempt —
    // exactly the class of failure the fallback ladder exists for.
    expect(isRetryable(new Error('Gemini returned empty response (finishReason: SAFETY). Try again.'))).toBe(true)
    expect(isRetryable(new Error('Gemini returned empty response (finishReason: unknown). Try again.'))).toBe(true)
  })

  it('keeps real client errors non-retryable', () => {
    expect(isRetryable(new Error('Gemini API error (400): invalid request'))).toBe(false)
    expect(isRetryable(new Error('API key not valid'))).toBe(false)
  })
})
