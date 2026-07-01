import { describe, expect, it } from 'vitest'
import {
  buildAssistantContinuityMessage,
  buildChatLLMRequest,
  buildOutcomeNoteFromActionOutcome,
  compactActionForHistory,
  prepareTurnLedgerChatTurn,
  renderTurnLedgerForDisplay,
  renderTurnLedgerForModel,
  stripActionAnnotations,
  type LLMProvider,
  type PersonaConfig,
} from '../src/index.js'

const mockProvider: LLMProvider = {
  name: 'mock',
  async chat() { return { text: '{"message":"ok"}' } },
}

const config: PersonaConfig = {
  identity: {
    name: 'Builder',
    expertise: ['implementation'],
    relationship: 'builder',
    northStar: 'ship working artifacts',
  },
  voice: { tone: 'balanced', style: 'quick' },
  provider: mockProvider,
}

describe('assistant continuity builder', () => {
  it('stores outcome notes while keeping raw action annotations strippable', () => {
    const stored = buildAssistantContinuityMessage({
      message: 'I updated the file.',
      modelOutcomeNotes: ['Spec summary updated.'],
      actionOutcomes: [{
        action: { name: 'editFile', params: { path: 'spec.md', edits: [{ oldText: 'a', newText: 'b' }] } },
        status: 'executed',
        success: true,
      }],
      actionAnnotations: ['editFile: path=spec.md, edits=<raw>'],
    })

    expect(stored).toContain('---outcomes:')
    expect(stored).toContain('Spec summary updated.')
    expect(stored).toContain('editFile {path="spec.md", editCount=1} executed.')
    expect(stored).toContain('---actions: editFile: path=spec.md')

    const modelHistory = stripActionAnnotations([{ role: 'assistant' as const, content: stored }])
    expect(modelHistory[0].content).toContain('---outcomes:')
    expect(modelHistory[0].content).not.toContain('---actions:')
  })

  it('does not replay large action params in compact function-call history', () => {
    const hugeBody = 'A'.repeat(5000)
    const stored = buildAssistantContinuityMessage({
      message: 'Wrote the file.',
      actionOutcomes: [{
        action: { name: 'writeFile', params: { path: 'index.html', content: hugeBody } },
        outcomeNote: 'index.html written successfully.',
      }],
      actionsForHistory: [{ name: 'writeFile', params: { path: 'index.html', content: hugeBody } }],
      historyTransport: 'compact-function-calls',
    })
    const parsed = JSON.parse(stored) as { message: string; actions: Array<{ params: Record<string, unknown> }> }

    expect(parsed.message).toContain('index.html written successfully.')
    expect(parsed.actions[0].params.content).toBe('<omitted 5000 bytes>')
    expect(stored).not.toContain(hugeBody)
  })

  it('turns failed and proposed actions into factual future-visible notes', () => {
    expect(buildOutcomeNoteFromActionOutcome({
      action: { name: 'saveMemory', params: { content: 'x' } },
      status: 'failed',
      success: false,
      error: 'storage unavailable',
    })).toBe('saveMemory failed: storage unavailable')

    expect(buildOutcomeNoteFromActionOutcome({
      action: { name: 'sendEmail', params: { id: 'm1' } },
      status: 'proposed',
      success: true,
    })).toBe('sendEmail {id="m1"} was proposed but not executed yet.')
  })

  it('compacts editFile payloads to an edit count', () => {
    const compacted = compactActionForHistory({
      name: 'editFile',
      params: {
        path: 'spec.md',
        edits: [
          { oldText: 'long old text', newText: 'new text' },
          { oldText: 'second old text', newText: 'second new text' },
        ],
      },
    })

    expect(compacted.params).toEqual({
      path: 'spec.md',
      edits: '<omitted 2 edits>',
    })
  })

  it('renders turn ledgers with action outcomes attached to the message that caused them', () => {
    const history = renderTurnLedgerForModel([
      {
        actorId: 'pm',
        message: 'I will write the spec docs.',
        actionOutcomes: [
          {
            action: { name: 'writeFile', params: { path: 'spec/README.md', content: 'x'.repeat(5000) } },
            outcomeNote: 'writeFile spec/README.md\nSuccessfully wrote 5000 bytes.',
          },
        ],
        actionAnnotations: ['writeFile: path=spec/README.md, content=<raw>'],
      },
      {
        actorId: 'builder',
        message: 'I will list the workspace before building.',
        actionOutcomes: [
          {
            action: { name: 'listFiles', params: { path: '.' } },
            outcomeNote: 'listFiles .\nspec/README.md (10 lines, 5000 bytes)\nartifact/index.html (3 lines, 120 bytes)',
          },
        ],
      },
    ], { perspectiveActorId: 'builder' })

    expect(history).toEqual([
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({ role: 'assistant' }),
    ])
    expect(history[0].content).toContain('Pm:\nI will write the spec docs.')
    expect(history[1].content).toContain('Builder:\nI will list the workspace before building.')
    expect(history[0].content).toContain('I will write the spec docs.')
    expect(history[0].content).toContain('---outcomes:')
    expect(history[0].content).toContain('Successfully wrote 5000 bytes.')
    expect(history[0].content).not.toContain('xxxxx')
    expect(history[0].content).toContain('---actions:')
    expect(history[1].content).toContain('listFiles .')
    expect(history[1].content).toContain('artifact/index.html')
  })

  it('renders fresh action results from the turn ledger before decaying to stale recovery text', () => {
    const entries = [
      {
        turn: 2,
        actorId: 'pm',
        message: 'I am reading the brief.',
        actionOutcomes: [
          {
            action: { name: 'readFile', params: { path: 'input/brief.md' } },
            outcomeNote: '<readFile result for input/brief.md no longer carried; read again if exact contents are needed>',
            resultText: 'readFile input/brief.md\ncontent:\n# Brief\nBuild the lantern game.',
            resultTurns: 1,
            staleText: '<readFile result for input/brief.md no longer carried; read again if exact contents are needed>',
          },
        ],
      },
    ]

    const fresh = renderTurnLedgerForModel(entries, {
      perspectiveActorId: 'pm',
      currentTurn: 3,
    })
    const stale = renderTurnLedgerForModel(entries, {
      perspectiveActorId: 'pm',
      currentTurn: 4,
    })

    expect(fresh[0].content).toContain('# Brief')
    expect(fresh[0].content).not.toContain('no longer carried')
    expect(stale[0].content).not.toContain('# Brief')
    expect(stale[0].content).toContain('no longer carried')
  })

  it('presents latest own action outcomes as the current app event instead of fake Continue history', () => {
    const prepared = prepareTurnLedgerChatTurn([
      {
        turn: 2,
        actorId: 'pm',
        message: 'I will read the brief before shaping the product handoff.',
        actionOutcomes: [
          {
            action: { name: 'readFile', params: { path: 'input/game-brief.md' } },
            outcomeNote: '<readFile result for input/game-brief.md no longer carried; read again if exact contents are needed>',
            resultText: 'readFile input/game-brief.md\ncontent:\n# Clockwork Courier\nShifting city, deadlines, battery, route risk.',
            resultTurns: 4,
            staleText: '<readFile result for input/game-brief.md no longer carried; read again if exact contents are needed>',
          },
        ],
      },
    ], {
      perspectiveActorId: 'pm',
      currentTurn: 3,
      fallbackMessage: 'Continue.',
    })

    expect(prepared.source).toBe('own-action-outcome')
    expect(prepared.turnLedger).toEqual([])
    expect(prepared.message).toContain('Current work stream from your previous turn')
    expect(prepared.message).toContain('your narration/inner voice')
    expect(prepared.message).toContain('compact action narration')
    expect(prepared.message).toContain('not a raw action dump')
    expect(prepared.message).toContain('raw parameters are omitted')
    expect(prepared.message).toContain('Successful outcomes already changed the world')
    expect(prepared.message).toContain('I will read the brief')
    expect(prepared.message).toContain('# Clockwork Courier')
    expect(prepared.message).toContain('Shifting city, deadlines, battery, route risk.')
    expect(prepared.message).not.toContain('"params"')
    expect(prepared.message).not.toContain('"path"')
    expect(prepared.message).not.toBe('Continue.')
  })

  it('uses the latest peer ledger entry as the current message instead of a synthetic continuation', () => {
    const prepared = prepareTurnLedgerChatTurn([
      {
        turn: 1,
        actorId: 'pm',
        message: 'I am preparing the brief.',
      },
      {
        turn: 2,
        actorId: 'pm',
        message: 'Builder, the design is ready in spec/design.md.',
        actionOutcomes: [{
          action: { name: 'applyPatch', params: { path: 'spec/design.md' } },
          resultText: 'applyPatch\nSuccessfully wrote spec/design.md.\nChanged file state:\n- spec/design.md — 1 line, 8 bytes\nExact file contents are not carried in WORK HISTORY; use readFile if exact contents are needed.',
          resultTurns: 2,
          staleText: 'applyPatch\nSuccessfully wrote spec/design.md. Exact file contents are not carried.',
        }],
      },
    ], {
      perspectiveActorId: 'builder',
      currentTurn: 3,
      fallbackMessage: 'Continue.',
    })

    expect(prepared.message).toContain('Builder, the design is ready')
    expect(prepared.message).toContain('Pm:\nBuilder, the design is ready')
    expect(prepared.message).toContain('spec/design.md — 1 line')
    expect(prepared.message).not.toContain('# Design')
    expect(prepared.source).toBe('fresh-peer-turn')
    expect(prepared.turnLedger).toHaveLength(1)
    expect(prepared.turnLedger[0].message).toBe('I am preparing the brief.')
  })

  it('uses session participant labels when rendering model-visible ledger speakers', () => {
    const { request } = buildChatLLMRequest(config, {
      message: 'Continue.',
      turnLedgerActorId: 'builder',
      session: {
        actorId: 'builder',
        participants: [
          { id: 'pm', label: 'Product Manager' },
          { id: 'builder', label: 'Builder' },
        ],
      },
      turnLedger: [
        { actorId: 'pm', message: 'The design needs fair deadlines.' },
        { actorId: 'builder', message: 'I will update the game rules.' },
      ],
    })

    expect(request.history[0]).toEqual(expect.objectContaining({
      role: 'user',
      content: 'Product Manager:\nThe design needs fair deadlines.',
    }))
    expect(request.history[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Builder:\nI will update the game rules.',
    }))
  })

  it('keeps the fallback message when the latest ledger entry belongs to the same actor', () => {
    const prepared = prepareTurnLedgerChatTurn([
      {
        turn: 1,
        actorId: 'builder',
        message: 'I wrote the game files.',
      },
    ], {
      perspectiveActorId: 'builder',
      currentTurn: 2,
      fallbackMessage: 'Continue.',
    })

    expect(prepared.message).toBe('Continue.')
    expect(prepared.source).toBe('fallback')
    expect(prepared.turnLedger).toHaveLength(1)
  })

  it('renders display history without hidden outcome annotations', () => {
    const display = renderTurnLedgerForDisplay([
      {
        actorId: 'pm',
        message: 'I will write the spec docs.',
        actionOutcomes: [{ outcomeNote: 'writeFile spec/README.md succeeded.' }],
      },
    ], { perspectiveActorId: 'builder' })

    expect(display).toEqual([
      { role: 'user', content: 'I will write the spec docs.' },
    ])
  })

  it('builds LLM history from turnLedger and strips raw action annotations', () => {
    const { request } = buildChatLLMRequest(config, {
      message: 'Continue.',
      turnLedgerActorId: 'builder',
      turnLedgerCurrentTurn: 2,
      turnLedger: [
        {
          turn: 1,
          actorId: 'builder',
          message: 'I will list files.',
          actionOutcomes: [{ outcomeNote: 'listFiles .\nartifact/index.html (3 lines, 120 bytes)' }],
          actionAnnotations: ['listFiles: path=.'],
        },
      ],
    })

    expect(request.history).toEqual([
      expect.objectContaining({ role: 'assistant' }),
    ])
    expect(request.history[0].content).toContain('I will list files.')
    expect(request.history[0].content).toContain('artifact/index.html')
    expect(request.history[0].content).not.toContain('---actions:')
  })

  it('keeps compact own action references in chat history without contradicting private work history', () => {
    const { request } = buildChatLLMRequest(config, {
      message: 'Continue.',
      turnLedgerActorId: 'builder',
      context: {
        workHistory: ['turn 1 · action: readFile spec/product_requirements.md\n(full PRD content)'],
      },
      turnLedger: [
        {
          actorId: 'builder',
          message: 'I will read the PRD.',
          actionOutcomes: [{
            action: { name: 'readFile', params: { path: 'spec/product_requirements.md' } },
            outcomeNote: '<readFile result for spec/product_requirements.md no longer carried in WORK HISTORY; read the file again only if exact contents are needed>',
            resultText: 'readFile spec/product_requirements.md\n# Full PRD body that already lives in WORK HISTORY',
            resultTurns: 4,
          }],
        },
        {
          actorId: 'pm',
          message: 'I updated the spec.',
          actionOutcomes: [{ outcomeNote: 'applyPatch\nSuccessfully wrote spec/PRD.md.' }],
        },
      ],
    })

    expect(request.history).toHaveLength(2)
    expect(request.history[0].role).toBe('assistant')
    expect(request.history[0].content).toContain('I will read the PRD.')
    expect(request.history[0].content).toContain('---outcomes:')
    expect(request.history[0].content).toContain('readFile {path="spec/product_requirements.md"} completed.')
    expect(request.history[0].content).not.toContain('no longer carried')
    expect(request.history[0].content).not.toContain('read the file again')
    expect(request.history[0].content).not.toContain('# Full PRD body')
    expect(request.history[1].role).toBe('user')
    expect(request.history[1].content).toContain('I updated the spec.')
    expect(request.history[1].content).toContain('Successfully wrote spec/PRD.md.')
  })

  it('keeps same-actor continuity but omits peer chat history in focus mode when private work history is present', () => {
    const { request } = buildChatLLMRequest(config, {
      message: 'Continue.',
      promptMode: 'focus',
      turnLedgerActorId: 'builder',
      context: {
        workHistory: ['turn 1 · action: focus mode entered for the active build.'],
      },
      turnLedger: [
        {
          actorId: 'builder',
          message: 'I am going to map the room graph and state model before editing files.',
          actionOutcomes: [{ outcomeNote: 'focus mode entered.' }],
        },
        {
          actorId: 'pm',
          message: 'Please start with a basic shell.',
        },
      ],
    })

    expect(request.history).toHaveLength(1)
    expect(request.history[0].role).toBe('assistant')
    expect(request.history[0].content).toContain('I am going to map the room graph and state model before editing files.')
    expect(request.history[0].content).toContain('focus mode entered.')
    expect(request.history[0].content).not.toContain('Please start with a basic shell.')
    expect(request.message).toBe('Continue.')
  })
})
