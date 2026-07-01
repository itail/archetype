import {
  GoogleGenerativeAI,
  SchemaType,
  type GenerationConfig,
  type Schema,
  type Part,
} from '@google/generative-ai'
import { createHash } from 'node:crypto'
import type { LLMProvider, LLMProviderRequest, LLMProviderResponse, ActionDefinition, EntityConfig, LLMProviderAttempt, LLMRequestFingerprint } from '../types.js'
import { zodToGeminiSchema } from './zod-to-gemini.js'

const FOLLOW_UPS_CORE_DESCRIPTION =
  'Optional short phrases the USER would tap to continue the conversation — written in their voice, not yours. Example: "My right bicep is still sore" not "How is your right bicep feeling?"'

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex')
}

function traceSafeMessageParts(messageParts: string | Part[]): unknown {
  if (typeof messageParts === 'string') return messageParts
  return messageParts.map(part => {
    const inlineData = (part as unknown as { inlineData?: { mimeType?: string; data?: string } }).inlineData
    if (inlineData?.data) {
      return {
        inlineData: {
          mimeType: inlineData.mimeType,
          dataSha256: sha256(inlineData.data),
          dataLength: inlineData.data.length,
        },
      }
    }
    return part
  })
}

function buildFollowUpsDescription(appDescription?: string): string {
  if (!appDescription?.trim()) return FOLLOW_UPS_CORE_DESCRIPTION
  return `${FOLLOW_UPS_CORE_DESCRIPTION}\n\nApp-specific context: ${appDescription.trim()}`
}

export interface GeminiConfig {
  model?: string
  apiKey?: string
  temperature?: number
  timeoutMs?: number
  /** @deprecated Use fallbackModels for a full cascade chain */
  fallbackModel?: string
  /** Ordered cascade of fallback models. Each gets full retry treatment. */
  fallbackModels?: string[]
  /** Gemini 2.5 thinking budget in tokens. Default 8192 matches pi's medium preset.
   *  Lower values (e.g. 4096) reduce per-call latency for simpler prompts at
   *  the cost of less chain-of-thought. Pass 0 to disable thinking entirely. */
  thinkingBudget?: number
  maxRetries?: number
  /** Use Gemini's native function-calling API instead of JSON-schema-constrained
   *  response. When the persona's responseSchema has the Archetype action
   *  shape `{ actions: { items: { anyOf: [{name, params}, ...] } } }`, each
   *  action becomes a function declaration and the model emits functionCall
   *  parts natively instead of a JSON-text blob. Pi (the reference coding
   *  agent) runs in this mode; JSON-schema mode is a secondary constraint the
   *  model has to simulate instead of using its pretrained tool-use fluency.
   *  Default off — existing Archetype consumers see no behavior change. */
  useFunctionCalling?: boolean
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash'
export const DEFAULT_GEMINI_FALLBACK_MODELS = ['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'] as const

/**
 * Remove Archetype's "Return one raw JSON object" output directive from the
 * system prompt. In function-calling mode the directive conflicts with tool
 * use — the model follows the explicit text instruction instead of calling
 * functions. Handled as a regex on known marker headings so we don't have to
 * thread a flag through Archetype's prompt builder.
 */
function stripJsonOutputDirective(systemPrompt: string): string {
  // Each block is separated from its neighbours by a blank line. Match from
  // the heading through the whole block up to the next blank line (or end).
  // Without `/m` the `$` means end-of-string, so a trailing block also strips.
  const markerPatterns = [
    /(?:^|\n)Output contract:\n[\s\S]*?(?=\n\n|$)/,
    /(?:^|\n)Output:\n[\s\S]*?(?=\n\n|$)/,
  ]
  let cleaned = systemPrompt
  for (const pat of markerPatterns) {
    cleaned = cleaned.replace(pat, '')
  }
  return `${cleaned.trimEnd()}

Call tools directly to take actions. Emit text only to narrate what you are doing.`
}

/**
 * Convert Archetype's JSON-schema action shape into Gemini function declarations.
 * Archetype builds `responseSchema.properties.actions.items.anyOf = [{name: enum, params: {...}}, ...]`;
 * each entry becomes a function declaration `{name, description, parameters}`.
 * Returns null if the schema isn't the expected Archetype action shape
 * (CRUD-only schemas, bare text responses, etc. fall through to JSON mode).
 */
function extractFunctionDeclarationsFromSchema(
  responseSchema: Record<string, unknown> | undefined,
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> | null {
  if (!responseSchema || typeof responseSchema !== 'object') return null
  const properties = (responseSchema as { properties?: Record<string, unknown> }).properties
  const actions = properties?.actions as { items?: { anyOf?: unknown[] } } | undefined
  const anyOf = actions?.items?.anyOf
  if (!Array.isArray(anyOf) || anyOf.length === 0) return null

  const declarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = []
  for (const entry of anyOf) {
    if (!entry || typeof entry !== 'object') continue
    const entryProps = (entry as { properties?: Record<string, unknown> }).properties
    const nameField = entryProps?.name as { enum?: unknown[] } | undefined
    const nameEnum = nameField?.enum
    const name = Array.isArray(nameEnum) && typeof nameEnum[0] === 'string' ? nameEnum[0] : null
    if (!name) continue
    const params = (entryProps?.params ?? { type: 'object', properties: {} }) as Record<string, unknown>
    // Pull the action's description from the variant (placed there by
    // buildGeminiResponseSchema). Fall back to a generic only when
    // absolutely no description is available, because a generic description
    // starves the model of tool semantics and forces it to infer from the
    // name alone.
    const description = typeof (entry as { description?: unknown }).description === 'string'
      ? (entry as { description: string }).description
      : `Call ${name}.`
    declarations.push({
      name,
      description,
      parameters: params,
    })
  }
  return declarations.length > 0 ? declarations : null
}

/**
 * Build the ordered fallback chain from config + env vars.
 * Precedence: fallbackModels config > fallbackModel config > GEMINI_FALLBACK_MODELS env > GEMINI_FALLBACK_MODEL env > defaults.
 * Passing fallbackModels: [] explicitly disables fallback instead of inheriting env defaults.
 * The primary model and duplicates are excluded.
 */
export function resolveFallbackChain(
  primaryModel: string,
  config?: Pick<GeminiConfig, 'fallbackModel' | 'fallbackModels'>,
): string[] {
  let raw: string[]

  if (config && 'fallbackModels' in config) {
    raw = config.fallbackModels ?? []
  } else if (config?.fallbackModel) {
    raw = [config.fallbackModel]
  } else if (process.env.GEMINI_FALLBACK_MODELS) {
    raw = process.env.GEMINI_FALLBACK_MODELS.split(',').map(s => s.trim()).filter(Boolean)
  } else if (process.env.GEMINI_FALLBACK_MODEL) {
    raw = [process.env.GEMINI_FALLBACK_MODEL]
  } else {
    raw = [...DEFAULT_GEMINI_FALLBACK_MODELS]
  }

  const seen = new Set<string>([primaryModel])
  return raw.filter(m => {
    if (seen.has(m)) return false
    seen.add(m)
    return true
  })
}

/**
 * Create a Gemini LLM provider.
 * API key resolved from: config.apiKey → GEMINI_API_KEY env var.
 */
export function Gemini(config?: GeminiConfig): LLMProvider {
  const modelName = config?.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL
  const fallbackChain = resolveFallbackChain(modelName, config)
  const modelChain = [modelName, ...fallbackChain]
  const maxRetries = config?.maxRetries ?? 0
  const defaultTemperature = config?.temperature ?? 0.7
  const timeoutMs = config?.timeoutMs ?? 90 * 1000

  return {
    name: `gemini:${modelName}`,
    historyTransport: config?.useFunctionCalling ? 'compact-function-calls' : 'text',

    async chat(request: LLMProviderRequest): Promise<LLMProviderResponse> {
      const apiKey = config?.apiKey ?? process.env.GEMINI_API_KEY
      if (!apiKey) {
        throw new Error('Gemini API key not set — pass apiKey in config or set GEMINI_API_KEY env var')
      }

      const genAI = new GoogleGenerativeAI(apiKey)
      const temperature = request.temperature ?? defaultTemperature

      // Thinking budget. Pi runs gemini-2.5-flash with `thinkingBudget: 8192`
      // (its "medium" effort preset) for coding tasks. We used to pass -1
      // (unlimited dynamic), which let the model burn its entire output
      // budget on thinking tokens and then return MALFORMED_FUNCTION_CALL
      // because there was no room left to emit the actual tool call. Match
      // pi's cap so the model reasons thoroughly but leaves space for the
      // function call args.
      // See pi-ai's google.js getGoogleBudget() — 2.5-flash@medium => 8192.
      const generationConfig: GenerationConfig & {
        thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean }
      } = {
        temperature,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: config?.thinkingBudget ?? 8192 },
        ...(request.responseSchema
          ? { responseSchema: request.responseSchema as unknown as Schema }
          : {}),
      }

      // Gemini requires history to start with 'user' role — strip leading assistant messages
      let trimmedHistory = request.history
      while (trimmedHistory.length > 0 && trimmedHistory[0].role !== 'user') {
        trimmedHistory = trimmedHistory.slice(1)
      }

      const historyForChat = trimmedHistory.map(msg => {
        if (msg.role === 'user') {
          return { role: 'user' as const, parts: [{ text: msg.content }] }
        }
        // In function-calling mode, the assistant content is the Archetype
        // JSON wrapper `{message, actions: [{name, params}]}`. Parse and
        // reconstruct structured parts so Gemini's conversation history
        // contains real `functionCall` blocks, not a text dump. Without
        // this, the model sees empty/opaque prior model turns and eventually
        // produces MALFORMED_FUNCTION_CALL because it's guessing.
        if (config?.useFunctionCalling) {
          try {
            const parsed = JSON.parse(msg.content) as {
              message?: unknown
              actions?: Array<{ name?: unknown; params?: unknown }>
            }
            const parts: Array<Record<string, unknown>> = []
            if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
              parts.push({ text: parsed.message })
            }
            if (Array.isArray(parsed.actions)) {
              for (const a of parsed.actions) {
                if (a && typeof a === 'object' && typeof a.name === 'string') {
                  parts.push({
                    functionCall: {
                      name: a.name,
                      args: (a.params as Record<string, unknown>) ?? {},
                    },
                  })
                }
              }
            }
            if (parts.length > 0) {
              return { role: 'model' as const, parts: parts as unknown as Part[] }
            }
          } catch {
            // Fall through to plain text if parse fails
          }
        }
        return { role: 'model' as const, parts: [{ text: msg.content }] }
      })

      // Build message parts — multimodal when attachments present
      const messageParts: string | Part[] = request.attachments?.length
        ? [
            { text: request.message } as Part,
            ...request.attachments.map(att => ({
              inlineData: { mimeType: att.mimeType, data: att.data },
            } as Part)),
          ]
        : request.message

      // Function-calling mode: use Gemini's native tools API when requested.
      // This matches what pi (the reference coding agent) does — `tools:
      // convertTools(...)` in its Gemini call — which unlocks the model's
      // pretrained tool-use fluency rather than asking it to simulate tool
      // calls inside a constrained JSON blob.
      const fnDecls = config?.useFunctionCalling
        ? extractFunctionDeclarationsFromSchema(request.responseSchema)
        : null

      const requestFingerprint: LLMRequestFingerprint = {
        sha256: sha256({
          systemInstruction: request.systemPrompt,
          generationConfig,
          historyForChat,
          messageParts: traceSafeMessageParts(messageParts),
          responseSchema: request.responseSchema ?? null,
          useFunctionCalling: Boolean(fnDecls && fnDecls.length > 0),
        }),
        systemPromptSha256: sha256(request.systemPrompt),
        historySha256: sha256(historyForChat),
        messageSha256: sha256(traceSafeMessageParts(messageParts)),
        ...(request.responseSchema ? { responseSchemaSha256: sha256(request.responseSchema) } : {}),
        historyCount: historyForChat.length,
        attachmentCount: request.attachments?.length ?? 0,
      }
      const attempts: LLMProviderAttempt[] = []

      /** Attempt a single chat call with the given model name */
      const attempt = async (targetModel: string): Promise<LLMProviderResponse> => {
        const modelInit: Parameters<typeof genAI.getGenerativeModel>[0] = {
          model: targetModel,
          systemInstruction: request.systemPrompt,
          generationConfig,
        }
        if (fnDecls && fnDecls.length > 0) {
          // In function-calling mode, drop responseMimeType/responseSchema —
          // those would conflict with tool-call output. Keep temperature +
          // thinkingConfig.
          const fnGenConfig = { ...generationConfig } as Record<string, unknown>
          delete fnGenConfig.responseMimeType
          delete fnGenConfig.responseSchema
          modelInit.generationConfig = fnGenConfig as typeof generationConfig
          ;(modelInit as unknown as { tools?: unknown }).tools = [{ functionDeclarations: fnDecls }]
          ;(modelInit as unknown as { toolConfig?: unknown }).toolConfig = {
            functionCallingConfig: { mode: 'AUTO' },
          }
          // Archetype's default system prompt includes a JSON-output contract
          // ("Return one raw JSON object with 'message' and optional 'actions'").
          // With tools enabled, that directive competes with tool use — the
          // model follows the explicit instruction and emits JSON as text
          // instead of calling functions. Strip the JSON-output section.
          modelInit.systemInstruction = stripJsonOutputDirective(request.systemPrompt)
        }
        const model = genAI.getGenerativeModel(modelInit)

        const chat = model.startChat({ history: historyForChat })

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Gemini request timed out after ${timeoutMs / 1000}s`)),
            timeoutMs,
          )
        )

        const result = await Promise.race([
          chat.sendMessage(messageParts),
          timeoutPromise,
        ])

        if (fnDecls && fnDecls.length > 0) {
          // Collect text parts + function_call parts from the model's response,
          // then reshape as Archetype's expected `{message, actions}` JSON text
          // so chat.ts parses it the same way it parses JSON-mode output.
          const parts = result.response.candidates?.[0]?.content?.parts ?? []
          let messageText = ''
          const actions: Array<{ name: string; params: Record<string, unknown> }> = []
          for (const p of parts as unknown as Array<Record<string, unknown>>) {
            if (p.thought) continue
            if (typeof p.text === 'string' && p.text.length > 0) {
              messageText += p.text
            }
            const fc = p.functionCall as { name?: string; args?: Record<string, unknown> } | undefined
            if (fc && typeof fc.name === 'string') {
              actions.push({ name: fc.name, params: fc.args ?? {} })
            }
          }
          if (!messageText && actions.length === 0) {
            const finishReason = result.response.candidates?.[0]?.finishReason
            throw new Error(
              `Gemini returned empty response (finishReason: ${finishReason ?? 'unknown'}). Try again.`,
            )
          }
          attempts.push({ model: targetModel, status: 'success' })
          return { text: JSON.stringify({ message: messageText, actions }), model: targetModel, requestedModel: modelName, requestFingerprint, attempts: [...attempts] }
        }

        const text = result.response.text()
        if (!text?.trim()) {
          const finishReason = result.response.candidates?.[0]?.finishReason
          throw new Error(
            `Gemini returned empty response (finishReason: ${finishReason ?? 'unknown'}). Try again.`
          )
        }

        attempts.push({ model: targetModel, status: 'success' })
        return { text, model: targetModel, requestedModel: modelName, requestFingerprint, attempts: [...attempts] }
      }

      // Cascade through model chain — each model gets full retry treatment
      let lastError: Error | undefined
      for (let m = 0; m < modelChain.length; m++) {
        const currentModel = modelChain[m]
        if (m > 0) {
          console.warn(`[archetype] ${modelChain[m - 1]} exhausted ${maxRetries + 1} attempts — falling back to ${currentModel}`)
        }

        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await attempt(currentModel)
          } catch (err: unknown) {
            lastError = err instanceof Error ? err : new Error(String(err))
            const retryable = isRetryable(lastError)
            attempts.push({ model: currentModel, status: 'failed', error: lastError.message, retryable })
            if (!retryable) {
              // Schema/config errors (400) won't be fixed by retrying or falling back — fail immediately.
              throw lastError
            }
            if (i < maxRetries) {
              const delayMs = backoffMs(i)
              console.warn(`[archetype] ${currentModel} attempt ${i + 1} failed: ${lastError.message} — retrying in ${Math.round(delayMs / 1000)}s`)
              await new Promise(r => setTimeout(r, delayMs))
              continue
            }
            break
          }
        }
      }

      throw lastError!
    },
  }
}

export function isRetryable(err: Error): boolean {
  const msg = err.message
  return msg.includes('503') || msg.includes('429') || msg.includes('overloaded')
    || msg.includes('timed out') || msg.includes('UNAVAILABLE') || msg.includes('RESOURCE_EXHAUSTED')
    // Empty/blocked responses (SAFETY, MAX_TOKENS, MALFORMED) are flaky per-model,
    // per-attempt — without this the fallback ladder never engages on them.
    || msg.includes('empty response')
}

function backoffMs(attempt: number): number {
  const base = attempt === 0 ? 1000 : 3000
  const jitter = Math.random() * 500
  return base + jitter
}

/**
 * Build the Gemini-compatible response schema for the standard chat format.
 * Includes message, actions, outcomeNotes, and optional follow-ups/diagnostics.
 *
 * When actions are provided, builds per-action variants using anyOf so the
 * model sees exact param types for each action (discriminated by name).
 *
 * Note: with large action sets (30+), Gemini may stringify params instead
 * of returning objects. validateActions() handles this by parsing JSON
 * strings before Zod validation.
 */
export function buildGeminiResponseSchema(
  actions?: Record<string, ActionDefinition>,
  options?: { followUpsDescription?: string; entities?: Record<string, EntityConfig>; promptMode?: 'conversation' | 'operational' | 'focus' },
) {
  const actionNames = actions ? Object.keys(actions) : []
  const hasEntities = options?.entities && Object.keys(options.entities).length > 0
  const focusMode = options?.promptMode === 'focus'

  // Build action array items — per-action variants when schemas available
  const variants: Record<string, unknown>[] = []

  if (actionNames.length > 0 && actions) {
    for (const name of actionNames) {
      const paramsSchema = zodToGeminiSchema(actions[name].schema)
      // Carry the action's description on the variant so that native
      // function-calling mode can surface it to the model as the tool's
      // description (instead of a generic `Call ${name}.` placeholder).
      // Without this, action descriptions are invisible to the model in
      // both focus-mode prose and FC mode — the model decides based on
      // name alone, which is why e.g. runTests was reached for without
      // understanding its Node-only runtime contract.
      const variant: Record<string, unknown> = {
        type: SchemaType.OBJECT,
        properties: {
          name: {
            type: SchemaType.STRING,
            enum: [name],
          },
          params: paramsSchema,
        },
        required: ['name', 'params'],
      }
      if (actions[name].description) {
        variant.description = actions[name].description
      }
      variants.push(variant)
    }
  }

  // Add crud variant when entities are declared — entity mutations flow through actions
  if (hasEntities) {
    const entityNames = Object.keys(options!.entities!)
    variants.push({
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          enum: ['crud'],
        },
        params: {
          type: SchemaType.OBJECT,
          properties: {
            operation: {
              type: SchemaType.STRING,
              enum: ['create', 'update', 'delete'],
            },
            entity: {
              type: SchemaType.STRING,
              enum: entityNames,
            },
            id: {
              type: SchemaType.STRING,
            },
            params: {
              type: SchemaType.STRING,
            },
          },
          required: ['operation', 'entity'],
        },
      },
      required: ['name', 'params'],
    })
  }

  let actionItems: Record<string, unknown>
  if (variants.length > 1) {
    actionItems = { anyOf: variants }
  } else if (variants.length === 1) {
    actionItems = variants[0]
  } else {
    actionItems = {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
        },
        params: {
          type: SchemaType.OBJECT,
          properties: {},
        },
      },
      required: ['name', 'params'],
    }
  }

  const properties: Record<string, unknown> = focusMode
    ? {
        message: {
          type: SchemaType.STRING,
        },
        actions: {
          type: SchemaType.ARRAY,
          // No maxItems cap. The loop executes actions sequentially in
          // emission order (see runAutonomousLoop). Capping the schema
          // to 1 contradicted the prompt-level "actions is a list"
          // guidance and silently prevented the model from bundling a
          // natural multi-action move (inspect + edit + verify).
          items: actionItems,
        },
        // Mirror the chat-mode diagnostics channel: a lean escape hatch
        // for "I want to do X but the tools don't express it." Without
        // this, the focus prompt promised the channel but the schema
        // rejected it.
        diagnostics: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
        },
      }
    : {
        message: {
          type: SchemaType.STRING,
          description: 'Your conversational response. Match length to complexity.',
        },
        actions: {
          type: SchemaType.ARRAY,
          items: actionItems,
        },
        attachmentNotes: {
          type: SchemaType.ARRAY,
          description: 'Optional compact factual carry-forward notes about uploaded images when they would materially help future turns without re-sending the raw image.',
          items: { type: SchemaType.STRING },
        },
        followUps: {
          type: SchemaType.ARRAY,
          description: buildFollowUpsDescription(options?.followUpsDescription),
          items: { type: SchemaType.STRING },
        },
        diagnostics: {
          type: SchemaType.ARRAY,
          description: 'Optional array of developer-facing observations about setup tensions. Empty array if nothing to flag.',
          items: { type: SchemaType.STRING },
        },
        outcomeNotes: {
          type: SchemaType.ARRAY,
          description: 'Continuity notes for future-you. The conversation is always visible, but structured actions are stripped from history. These notes fill the gap — what your actions changed that isn\'t obvious from the chat alone. Describe what changed, not how (action names/schemas may change). Only for structured actions you included. Empty when no actions.',
          items: { type: SchemaType.STRING },
        },
      }

  return {
    type: SchemaType.OBJECT,
    properties,
    required: focusMode ? ['message'] : ['message', 'actions', 'outcomeNotes'],
  }
}

/**
 * Build a Gemini-compatible response schema for silent action-only passes.
 * Useful for internal maintenance flows like retrospective memory updates.
 */
export function buildGeminiActionOnlySchema(
  actions?: Record<string, ActionDefinition>,
  entities?: Record<string, EntityConfig>,
) {
  const base = buildGeminiResponseSchema(actions, entities ? { entities } : undefined)
  return {
    type: SchemaType.OBJECT,
    properties: {
      actions: base.properties.actions,
      diagnostics: base.properties.diagnostics,
    },
  }
}
