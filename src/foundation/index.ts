import type { z } from 'zod'
import type { LLMProvider } from '../types.js'

export type FoundationArchetypeId =
  | 'builder'
  | 'product-manager'
  | 'nutrition-coach'
  | 'financial-advisor'
  | 'personal-assistant'
  | 'fitness-coach'

export interface FoundationArchetypeOptions {
  provider: LLMProvider
}

export interface FoundationArchetype {
  readonly kind: 'foundation-archetype'
  readonly id: FoundationArchetypeId
  inspect(): FoundationResolvedContract
  chat(message: string, input: { world: FoundationWorld }): Promise<never>
  work(request: string, input: { world: FoundationWorld }): Promise<never>
}

export interface FoundationResolvedContract {
  readonly archetype: FoundationArchetypeId
  readonly promptSealed: true
  readonly appAuthoredPromptAllowed: false
  readonly lowLevelToolContractsExposed: false
}

export type FoundationWorld =
  | WorkspaceWorld
  | NutritionWorld
  | FinanceWorld
  | InboxWorld
  | FitnessWorld
  | GenericWorld

export interface WorkspaceRoot {
  prefix: string
  path: string
  writable?: boolean
}

export interface WorkspaceWorldInput {
  roots: readonly WorkspaceRoot[]
}

export interface WorkspaceWorld {
  readonly kind: 'workspace-world'
  readonly roots: readonly WorkspaceRoot[]
}

export interface NutritionWorld {
  readonly kind: 'nutrition-world'
  readonly data: Record<string, unknown>
}

export interface FinanceWorld {
  readonly kind: 'finance-world'
  readonly data: Record<string, unknown>
}

export interface InboxWorld {
  readonly kind: 'inbox-world'
  readonly data: Record<string, unknown>
}

export interface FitnessWorld {
  readonly kind: 'fitness-world'
  readonly data: Record<string, unknown>
}

export interface GenericWorld {
  readonly kind: 'generic-world'
  readonly ledgers?: Record<string, FoundationLedger>
  readonly data?: Record<string, unknown>
}

export interface LedgerAdapter {
  list?: () => Promise<readonly Record<string, unknown>[]>
  create?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>
  update?: (id: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
  delete?: (id: string) => Promise<void>
}

export interface LedgerInput {
  name?: string
  schema: z.ZodType
  adapter: LedgerAdapter
}

export interface FoundationLedger {
  readonly kind: 'ledger'
  readonly name?: string
  readonly schema: z.ZodType
  readonly adapter: LedgerAdapter
  readonly singleton: boolean
  readonly docsSource: 'generated'
  readonly appAuthoredDocsAllowed: false
}

export type FoundationMemoryScope = 'person' | 'craft'

export interface MemoryAdapter {
  load?: (options?: { budget?: number }) => Promise<readonly Record<string, unknown>[]>
  save?: (memory: Record<string, unknown>) => Promise<Record<string, unknown>>
  update?: (id: string, updates: Record<string, unknown>) => Promise<Record<string, unknown>>
  delete?: (id: string) => Promise<void>
}

export interface MemorySurfaceInput {
  adapter: MemoryAdapter
  categories?: Record<string, string>
  budget?: number
}

export interface FoundationMemorySurface {
  readonly kind: 'memory-surface'
  readonly scope: FoundationMemoryScope
  readonly adapter: MemoryAdapter
  readonly categories?: Record<string, string>
  readonly budget?: number
  readonly semanticsOwner: 'archetype'
  readonly appAuthoredPromptAllowed: false
}

export interface AuditLedgerRecordsInput {
  ledgerName: string
  records: unknown
  canUpdate?: boolean
  canDelete?: boolean
}

export interface AuditMemoryRecordsInput {
  scope: FoundationMemoryScope
  records: unknown
  canUpdate?: boolean
  canDelete?: boolean
}

export interface FoundationAuditIssue {
  severity: 'error' | 'warn'
  message: string
  token?: string
}

export interface FoundationAuditResult {
  pass: boolean
  issues: FoundationAuditIssue[]
}

const PROMPT_KNOBS = [
  'prompt',
  'systemPrompt',
  'directives',
  'methodology',
  'taste',
  'northStar',
  'contextInputs',
  'extraSystemSections',
  'labels',
  'sections',
  'toolDescriptions',
  'memoryInstructions',
  'ledgerDocs',
  'actionContinuity',
  'workHistory',
] as const

const LOW_LEVEL_IMPORTS = [
  'buildSystemPrompt',
  'buildFocusContextInputs',
  'renderWorkHistoryEntries',
  'executeCoderAction',
  'executeCoderActions',
  'coderActions',
  'listFilesAction',
  'readFileAction',
  'applyPatchAction',
  'writeFileAction',
  'editFileAction',
  'deleteFileAction',
  'searchInFilesAction',
  'promptDump',
] as const

export const foundationPromptKnobs = [...PROMPT_KNOBS]
export const foundationLowLevelImports = [...LOW_LEVEL_IMPORTS]

export const archetype = {
  builder(options: FoundationArchetypeOptions): FoundationArchetype {
    return createFoundationArchetype('builder', options)
  },
  productManager(options: FoundationArchetypeOptions): FoundationArchetype {
    return createFoundationArchetype('product-manager', options)
  },
  nutritionCoach(options: FoundationArchetypeOptions): FoundationArchetype {
    return createFoundationArchetype('nutrition-coach', options)
  },
  financialAdvisor(options: FoundationArchetypeOptions): FoundationArchetype {
    return createFoundationArchetype('financial-advisor', options)
  },
  personalAssistant(options: FoundationArchetypeOptions): FoundationArchetype {
    return createFoundationArchetype('personal-assistant', options)
  },
  fitnessCoach(options: FoundationArchetypeOptions): FoundationArchetype {
    return createFoundationArchetype('fitness-coach', options)
  },
  world: {
    workspace(input: string | WorkspaceWorldInput): WorkspaceWorld {
      if (typeof input === 'string') {
        return { kind: 'workspace-world', roots: [{ prefix: 'workspace', path: input, writable: true }] }
      }
      rejectPromptKnobs(input as unknown as Record<string, unknown>, 'world.workspace')
      return { kind: 'workspace-world', roots: input.roots.map(root => ({ ...root })) }
    },
    nutrition(input: Record<string, unknown>): NutritionWorld {
      rejectPromptKnobs(input, 'world.nutrition')
      return { kind: 'nutrition-world', data: { ...input } }
    },
    finance(input: Record<string, unknown>): FinanceWorld {
      rejectPromptKnobs(input, 'world.finance')
      return { kind: 'finance-world', data: { ...input } }
    },
    inbox(input: Record<string, unknown>): InboxWorld {
      rejectPromptKnobs(input, 'world.inbox')
      return { kind: 'inbox-world', data: { ...input } }
    },
    fitness(input: Record<string, unknown>): FitnessWorld {
      rejectPromptKnobs(input, 'world.fitness')
      return { kind: 'fitness-world', data: { ...input } }
    },
    generic(input: { ledgers?: Record<string, FoundationLedger>; data?: Record<string, unknown> }): GenericWorld {
      rejectPromptKnobs(input, 'world')
      return { kind: 'generic-world', ...input }
    },
  },
  ledger(input: LedgerInput): FoundationLedger {
    return createLedger(input, false)
  },
  singletonLedger(input: LedgerInput): FoundationLedger {
    return createLedger(input, true)
  },
  memory: {
    person(input: MemorySurfaceInput): FoundationMemorySurface {
      return createMemorySurface('person', input)
    },
    craft(input: MemorySurfaceInput): FoundationMemorySurface {
      return createMemorySurface('craft', input)
    },
  },
  audit: {
    sourceBoundary: auditFoundationSourceBoundary,
    ledgerRecords: auditFoundationLedgerRecords,
    memoryRecords: auditFoundationMemoryRecords,
  },
} as const

export function rejectPromptKnobs(input: Record<string, unknown>, surface: string): void {
  for (const key of PROMPT_KNOBS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new Error(`${surface} does not accept app-authored prompt field "${key}"`)
    }
  }
}

export function auditFoundationSourceBoundary(source: string): FoundationAuditResult {
  const issues: FoundationAuditIssue[] = []
  for (const token of LOW_LEVEL_IMPORTS) {
    const namedImport = new RegExp(`import\\s*\\{[^}]*\\b${escapeRegExp(token)}\\b[^}]*\\}\\s*from\\s*['"]archetype['"]`, 'u')
    const namespaceAccess = new RegExp(`\\barchetype\\.${escapeRegExp(token)}\\b`, 'u')
    if (namedImport.test(source) || namespaceAccess.test(source)) {
      issues.push({
        severity: 'error',
        token,
        message: `Foundation consumers must not import low-level "${token}"`,
      })
    }
  }
  return { pass: issues.length === 0, issues }
}

export function auditFoundationLedgerRecords(input: AuditLedgerRecordsInput): FoundationAuditResult {
  const issues: FoundationAuditIssue[] = []
  if (typeof input.records === 'string') {
    issues.push({
      severity: 'error',
      message: `Ledger "${input.ledgerName}" was provided as serialized prose; ledgers must be typed records.`,
    })
    return { pass: false, issues }
  }
  if (!Array.isArray(input.records)) {
    issues.push({
      severity: 'error',
      message: `Ledger "${input.ledgerName}" records must be an array of typed records.`,
    })
    return { pass: false, issues }
  }

  const needsIds = input.canUpdate !== false || input.canDelete === true
  if (needsIds) {
    input.records.forEach((record, index) => {
      if (!record || typeof record !== 'object' || !('id' in record) || !(record as { id?: unknown }).id) {
        issues.push({
          severity: 'error',
          message: `Ledger "${input.ledgerName}" record ${index + 1} is mutable but has no visible id.`,
        })
      }
    })
  }

  return { pass: issues.length === 0, issues }
}

export function auditFoundationMemoryRecords(input: AuditMemoryRecordsInput): FoundationAuditResult {
  const issues: FoundationAuditIssue[] = []
  if (typeof input.records === 'string') {
    issues.push({
      severity: 'error',
      message: `${input.scope} memory was provided as serialized prose; memory must be typed records owned by Archetype semantics.`,
    })
    return { pass: false, issues }
  }
  if (!Array.isArray(input.records)) {
    issues.push({
      severity: 'error',
      message: `${input.scope} memory records must be an array of typed records.`,
    })
    return { pass: false, issues }
  }

  const needsIds = input.canUpdate !== false || input.canDelete !== false
  if (needsIds) {
    input.records.forEach((record, index) => {
      if (!record || typeof record !== 'object' || !('id' in record) || !(record as { id?: unknown }).id) {
        issues.push({
          severity: 'error',
          message: `${input.scope} memory record ${index + 1} is mutable but has no visible id.`,
        })
      }
    })
  }

  return { pass: issues.length === 0, issues }
}

function createFoundationArchetype(
  id: FoundationArchetypeId,
  options: FoundationArchetypeOptions,
): FoundationArchetype {
  rejectPromptKnobs(options as unknown as Record<string, unknown>, `archetype.${id}`)
  if (!options.provider) throw new Error(`archetype.${id} requires a provider`)
  const contract: FoundationResolvedContract = {
    archetype: id,
    promptSealed: true,
    appAuthoredPromptAllowed: false,
    lowLevelToolContractsExposed: false,
  }
  return {
    kind: 'foundation-archetype',
    id,
    inspect: () => contract,
    async chat() {
      throw new Error(`archetype.${id}.chat is not implemented yet`)
    },
    async work() {
      throw new Error(`archetype.${id}.work is not implemented yet`)
    },
  }
}

function createMemorySurface(
  scope: FoundationMemoryScope,
  input: MemorySurfaceInput,
): FoundationMemorySurface {
  rejectPromptKnobs(input as unknown as Record<string, unknown>, `memory.${scope}`)
  if (!input.adapter) throw new Error(`memory.${scope} requires an adapter`)
  assertFunction(input.adapter.load, `memory.${scope} adapter requires load()`)
  assertFunction(input.adapter.save, `memory.${scope} adapter requires save()`)
  assertFunction(input.adapter.update, `memory.${scope} adapter requires update()`)
  assertFunction(input.adapter.delete, `memory.${scope} adapter requires delete()`)
  return {
    kind: 'memory-surface',
    scope,
    adapter: input.adapter,
    categories: input.categories ? { ...input.categories } : undefined,
    budget: input.budget,
    semanticsOwner: 'archetype',
    appAuthoredPromptAllowed: false,
  }
}

function createLedger(input: LedgerInput, singleton: boolean): FoundationLedger {
  rejectPromptKnobs(input as unknown as Record<string, unknown>, 'ledger')
  if (!input.schema) throw new Error('ledger requires a schema')
  if (!input.adapter) throw new Error('ledger requires an adapter')
  assertFunction(input.adapter.list, 'ledger adapter requires list()')
  if (singleton) {
    assertFunction(input.adapter.update, 'singleton ledger adapter requires update()')
  } else {
    assertFunction(input.adapter.create, 'ledger adapter requires create()')
    assertFunction(input.adapter.update, 'ledger adapter requires update()')
    assertFunction(input.adapter.delete, 'ledger adapter requires delete()')
  }
  return {
    kind: 'ledger',
    name: input.name,
    schema: input.schema,
    adapter: input.adapter,
    singleton,
    docsSource: 'generated',
    appAuthoredDocsAllowed: false,
  }
}

function assertFunction(value: unknown, message: string): asserts value is (...args: any[]) => unknown {
  if (typeof value !== 'function') throw new Error(message)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
