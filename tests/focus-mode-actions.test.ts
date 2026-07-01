import { describe, expect, it } from 'vitest'
import {
  ENTER_FOCUS_MODE_ACTION_NAME,
  FOCUS_MODE_ACTIONS,
  RETURN_TO_SESSION_ACTION_NAME,
  UPDATE_FOCUS_WORK_ITEM_ACTION_NAME,
  buildFocusActionSets,
  enterFocusModeOutcomeNote,
  isEnterFocusModeAction,
  isReturnToSessionAction,
  isUpdateFocusWorkItemAction,
  returnToSessionOutcomeNote,
  updateFocusWorkItemOutcomeNote,
} from '../src/index.js'

describe('focus mode actions', () => {
  it('exposes small agent-callable focus transition actions', () => {
      expect(Object.keys(FOCUS_MODE_ACTIONS)).toEqual([
        ENTER_FOCUS_MODE_ACTION_NAME,
        UPDATE_FOCUS_WORK_ITEM_ACTION_NAME,
        RETURN_TO_SESSION_ACTION_NAME,
      ])
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain("this persona's ongoing work")
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain('future focus prompts')
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain('write a work item for your future self')
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain('future operating context')
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain('expert anchor')
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain('layered on top of source truth')
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain('expert judgment lens')
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain('work or product spine')
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain('manageable parts')
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain("not a handoff that replaces another expert's ownership")
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).toContain('focused work context begins on the next turn')
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.description).not.toMatch(/\bmust|required|always|never\b/i)
      expect(FOCUS_MODE_ACTIONS.enterFocusMode.schema.safeParse({
        workItem: 'Build a strong playable browser game.',
      }).success).toBe(true)
      expect(FOCUS_MODE_ACTIONS.updateFocusWorkItem.description).toContain('editable private operating context')
      expect(FOCUS_MODE_ACTIONS.updateFocusWorkItem.description).toContain('future focus prompts')
      expect(FOCUS_MODE_ACTIONS.updateFocusWorkItem.description).toContain('expert judgment lens')
      expect(FOCUS_MODE_ACTIONS.updateFocusWorkItem.description).toContain('reasoning decomposition')
      expect(FOCUS_MODE_ACTIONS.updateFocusWorkItem.description).toContain('not a quality check')
      expect(FOCUS_MODE_ACTIONS.updateFocusWorkItem.description).toContain('substitute source of truth')
      expect(FOCUS_MODE_ACTIONS.updateFocusWorkItem.schema.safeParse({
        workItem: 'Updated active work item.',
      }).success).toBe(true)
      expect(FOCUS_MODE_ACTIONS.returnToSession.description).toContain('Return from private focus work')
      expect(FOCUS_MODE_ACTIONS.returnToSession.description).toContain('visible session flow')
      expect(FOCUS_MODE_ACTIONS.returnToSession.description).toContain('not a quality check')
      expect(FOCUS_MODE_ACTIONS.returnToSession.schema.safeParse({
        message: 'The spec files are ready in spec/.',
        to: 'builder',
        state: 'ready',
      }).success).toBe(true)
    expect(FOCUS_MODE_ACTIONS.enterFocusMode.confidence).toBe('low')
    expect(FOCUS_MODE_ACTIONS.returnToSession.confidence).toBe('low')
  })

  it('recognizes transitions and renders compact outcome notes', () => {
    expect(isEnterFocusModeAction({ name: 'enterFocusMode' })).toBe(true)
    expect(isEnterFocusModeAction({ name: 'readFile' })).toBe(false)
    expect(isUpdateFocusWorkItemAction({ name: 'updateFocusWorkItem' })).toBe(true)
    expect(isUpdateFocusWorkItemAction({ name: 'readFile' })).toBe(false)
    expect(isReturnToSessionAction({ name: 'returnToSession' })).toBe(true)
    expect(isReturnToSessionAction({ name: 'readFile' })).toBe(false)
    expect(enterFocusModeOutcomeNote({
      params: {},
    })).toBe('focus mode entered.')
    expect(enterFocusModeOutcomeNote({
      params: { workItem: 'Build the game.' },
    })).toBe('focus mode entered with a persona-authored work item.')
    expect(updateFocusWorkItemOutcomeNote({
      params: { workItem: 'Updated work item.' },
    })).toBe('focus work item updated.')
    expect(returnToSessionOutcomeNote({
      params: {
        message: 'The spec files are ready in spec/.',
        to: 'builder',
      },
    })).toBe('returnToSession posted visible message to builder: The spec files are ready in spec/.')
  })

  it('keeps focus as a context transition instead of a capability gate', () => {
    const baseActions = {
      readFile: {
        description: 'Read a file.',
        confidence: 'low',
        schema: { safeParse: () => ({ success: true }) },
      },
      applyPatch: {
        description: 'Apply a patch.',
        confidence: 'low',
        schema: { safeParse: () => ({ success: true }) },
      },
    } as never

    const actionSets = buildFocusActionSets(baseActions)

    expect(Object.keys(actionSets.conversation)).toEqual([
      'enterFocusMode',
      'readFile',
      'applyPatch',
    ])
    expect(Object.keys(actionSets.focus)).toEqual([
      'readFile',
      'applyPatch',
      'updateFocusWorkItem',
      'returnToSession',
    ])
  })
})
