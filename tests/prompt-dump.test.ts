/**
 * Tests for dumpPromptForReview + createPromptTraceRecorder.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dumpPromptForReview, createPromptTraceRecorder } from '../src/audit/prompt-dump.js'
import { COACH_TEMPLATE } from '../src/playbook/templates.js'
import type { PersonaConfig } from '../src/types.js'

const mockProvider = { name: 'mock', chat: async () => ({ text: '' }) }

function config(): PersonaConfig {
  return { ...COACH_TEMPLATE, provider: mockProvider }
}

describe('dumpPromptForReview', () => {
  it('returns a DumpedPrompt with all expected fields for chat mode', () => {
    const dumped = dumpPromptForReview(config(), {
      message: 'hello coach',
      history: [],
      context: { threads: [{ id: 't1', title: 'x', status: 'active', owner: 'alex' }] },
      memories: [],
      timezone: 'UTC',
    })

    expect(dumped.mode).toBe('chat')
    expect(dumped.promptMode).toBe('conversation')
    expect(dumped.promptOrigin).toBe('user')
    expect(dumped.systemPrompt.length).toBeGreaterThan(0)
    expect(dumped.systemPrompt).toContain('Coach')
    expect(dumped.message).toBe('hello coach')
    expect(dumped.artifact).toContain('path: chat; prompt mode: conversation')
    expect(dumped.artifact).toContain('SYSTEM PROMPT')
    expect(dumped.artifact).toContain('USER MESSAGE')
    expect(dumped.artifact).toContain('Current user-visible message sent to the model')
    expect(dumped.artifact).toContain('hello coach')
  })

  it('labels app-originated current events distinctly from fresh user messages', () => {
    const dumped = dumpPromptForReview(config(), {
      message: 'Current work stream from your previous turn.\n\nI read the file.\n---outcomes: readFile ok',
      history: [],
      context: {},
      memories: [],
      timezone: 'UTC',
      promptOrigin: 'app',
    })

    expect(dumped.promptOrigin).toBe('app')
    expect(dumped.artifact).toContain('CURRENT APP EVENT')
    expect(dumped.artifact).toContain('App/runtime-initiated current event')
    expect(dumped.artifact).not.toContain('  USER MESSAGE\n')
    expect(dumped.artifact).toContain('readFile ok')
  })

  it('supports prompted-turn mode', () => {
    const dumped = dumpPromptForReview(
      config(),
      {
        intent: 'check in before the 1:1',
        turnKind: 'proactive-conversation',
        context: {},
        memories: [],
        timezone: 'UTC',
      },
      { mode: 'prompted-turn' },
    )
    expect(dumped.mode).toBe('prompted-turn')
    expect(dumped.promptMode).toBe('conversation')
    expect(dumped.systemPrompt).toContain('Coach')
  })

  it('labels focus prompt dumps by prompt mode, not just assembly path', () => {
    const dumped = dumpPromptForReview(config(), {
      message: 'focused work',
      history: [],
      context: {},
      timezone: 'UTC',
      promptMode: 'focus',
    })

    expect(dumped.mode).toBe('chat')
    expect(dumped.promptMode).toBe('focus')
    expect(dumped.artifact).toContain('path: chat; prompt mode: focus')
  })

  it('artifact contains the full prompt and history in order', () => {
    const dumped = dumpPromptForReview(config(), {
      message: 'the current message',
      history: [
        { role: 'user', content: 'earlier-user-message-X' },
        { role: 'assistant', content: 'earlier-assistant-message-Y' },
      ],
      context: {},
      timezone: 'UTC',
    })
    const xIdx = dumped.artifact.indexOf('earlier-user-message-X')
    const yIdx = dumped.artifact.indexOf('earlier-assistant-message-Y')
    const currentIdx = dumped.artifact.indexOf('the current message')
    expect(xIdx).toBeGreaterThan(0)
    expect(yIdx).toBeGreaterThan(xIdx)
    expect(currentIdx).toBeGreaterThan(yIdx)
  })

  it('renders human-readable history role labels in the artifact', () => {
    const dumped = dumpPromptForReview(config(), {
      message: 'current',
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      context: {},
      timezone: 'UTC',
    })

    expect(dumped.artifact).toContain('[USER TURN]')
    expect(dumped.artifact).toContain('[ASSISTANT TURN]')
    expect(dumped.artifact).not.toContain('[user]')
    expect(dumped.artifact).not.toContain('[assistant]')
  })

  it('renders attachment metadata without embedding attachment bytes', () => {
    const dumped = dumpPromptForReview(config(), {
      message: 'review screenshot',
      history: [],
      context: {},
      timezone: 'UTC',
      attachments: [{
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from('fake-png-bytes').toString('base64'),
      }],
    })

    expect(dumped.attachments).toHaveLength(1)
    expect(dumped.artifact).toContain('ATTACHMENTS')
    expect(dumped.artifact).toContain('1. image; image/png; 14 byte(s) decoded')
    expect(dumped.artifact).not.toContain(Buffer.from('fake-png-bytes').toString('base64'))
  })
})

describe('createPromptTraceRecorder', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'archetype-trace-test-'))
  })

  it('writes one file per turn via onBeforeChat', () => {
    const recorder = createPromptTraceRecorder({ outDir: tmp })
    recorder.onBeforeChat({
      request: { systemPrompt: 'SP_A', message: 'MSG_A', history: [], promptMode: 'focus' },
      turn: 1,
      attempt: 1,
    })
    recorder.onBeforeChat({
      request: { systemPrompt: 'SP_B', message: 'MSG_B', history: [{ role: 'user', content: 'previous' }] },
      turn: 2,
      attempt: 1,
    })

    const files = readdirSync(tmp)
    expect(files).toHaveLength(2)
    expect(files).toContain('turn-01-initial-attempt-1.json')
    expect(files).toContain('turn-02-initial-attempt-1.json')

    const t1 = JSON.parse(readFileSync(path.join(tmp, 'turn-01-initial-attempt-1.json'), 'utf8'))
    expect(t1.systemPrompt).toBe('SP_A')
    expect(t1.message).toBe('MSG_A')
    expect(t1.promptMode).toBe('focus')
    expect(t1.turn).toBe(1)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('respects traceGroup', () => {
    const recorder = createPromptTraceRecorder({ outDir: tmp, traceGroup: 'solo-builder' })
    recorder.onBeforeChat({
      request: { systemPrompt: 'SP', message: 'MSG', history: [] },
      turn: 0,
      attempt: 1,
    })
    const groupDir = path.join(tmp, 'solo-builder')
    const files = readdirSync(groupDir)
    expect(files).toHaveLength(1)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('format: "artifact" writes the human-readable form', () => {
    const recorder = createPromptTraceRecorder({ outDir: tmp, format: 'artifact' })
    recorder.onBeforeChat({
      request: {
        systemPrompt: 'SP',
        message: 'MSG',
        history: [],
        attachments: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('x').toString('base64') }],
      },
      turn: 1,
      attempt: 1,
    })
    const files = readdirSync(tmp)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.txt$/)
    const content = readFileSync(path.join(tmp, files[0]), 'utf8')
    expect(content).toContain('SYSTEM PROMPT')
    expect(content).toContain('USER MESSAGE')
    expect(content).toContain('ATTACHMENTS')
    expect(content).toContain('image; image/png; 1 byte(s) decoded')
    rmSync(tmp, { recursive: true, force: true })
  })

  it('format: "both" writes json and artifact', () => {
    const recorder = createPromptTraceRecorder({ outDir: tmp, format: 'both' })
    recorder.onBeforeChat({
      request: { systemPrompt: 'SP', message: 'MSG', history: [] },
      turn: 1,
      attempt: 1,
    })
    const files = readdirSync(tmp)
    expect(files).toHaveLength(2)
    expect(files.some(f => f.endsWith('.json'))).toBe(true)
    expect(files.some(f => f.endsWith('.txt'))).toBe(true)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('record() supports standalone dumps for hand-rolled harnesses', () => {
    const recorder = createPromptTraceRecorder({ outDir: tmp })
    const dumped = dumpPromptForReview(config(), {
      message: 'standalone',
      history: [],
      context: {},
      timezone: 'UTC',
    })
    recorder.record({ turn: 0, dumped })
    const files = readdirSync(tmp)
    expect(files).toHaveLength(1)
    const payload = JSON.parse(readFileSync(path.join(tmp, files[0]), 'utf8'))
    expect(payload.message).toBe('standalone')
    expect(payload.mode).toBe('chat')
    expect(payload.promptMode).toBe('conversation')
    rmSync(tmp, { recursive: true, force: true })
  })

  it('recordTurnResult appends raw response, actions, trace, and action results to the turn JSON', () => {
    const recorder = createPromptTraceRecorder({ outDir: tmp })
    recorder.onBeforeChat({
      request: { systemPrompt: 'SP', message: 'MSG', history: [] },
      turn: 4,
      attempt: 1,
    })

    recorder.recordTurnResult({
      turn: 4,
      rawResponse: JSON.stringify({
        message: 'Trying an edit.',
        actions: [{ name: 'editFile', params: { path: 'index.md', edits: [{ oldText: 'missing text', newText: 'replacement' }] } }],
      }),
      message: 'Trying an edit.',
      trace: {
        parseOk: true,
        actions: [{ name: 'editFile', params: { path: 'index.md', edits: [{ oldText: 'missing text', newText: 'replacement' }] }, status: 'valid' }],
      },
      actions: [{ name: 'editFile', params: { path: 'index.md', edits: [{ oldText: 'missing text', newText: 'replacement' }] } }],
      actionResults: [{
        action: { name: 'editFile', params: { path: 'index.md' } },
        result: { historyNote: 'editFile on index.md failed — no edits applied. oldText did not match.' },
      }],
    })

    const payload = JSON.parse(readFileSync(path.join(tmp, 'turn-04-initial-attempt-1.json'), 'utf8'))
    expect(payload.result.rawResponse).toContain('missing text')
    expect(payload.result.actions[0].name).toBe('editFile')
    expect(payload.result.trace.actions[0].params.edits[0].oldText).toBe('missing text')
    expect(payload.result.actionResults[0].result.historyNote).toContain('failed')
    rmSync(tmp, { recursive: true, force: true })
  })
})
