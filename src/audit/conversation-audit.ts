/**
 * Conversation Audit — reviews actual AI behavior for keystone violations.
 *
 * The prompt audit checks what the AI was told.
 * The conversation audit checks what the AI actually did.
 *
 * Output: explicit failure list with evidence. The developer decides
 * whether to build regression tests from the failures.
 */

import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai'
import { configVersion } from './version.js'
import type {
  ConversationAuditInput,
  ConversationAuditResult,
  ConversationAuditFailure,
} from './types.js'

const CONVERSATION_AUDIT_SYSTEM = `You are the Archetype meta judge — an expert in AI persona behavioral quality.

You are reviewing a conversation between an AI persona and a user.

THE KEYSTONE PRINCIPLE:
The AI persona is a domain expert. It has rich context — the user's data, history, memories, and the current situation. A great expert uses what it knows about THIS specific person to lead the conversation. The prompt paints the scenario; the expert decides how to show up.

WHAT GREAT LOOKS LIKE:
A well-functioning persona sounds like a professional who has been working with this client for months. It leads with expertise, grounds its advice in the specific data it has, and sounds like itself — not like a textbook or a generic assistant.

You are an expert in evaluating AI persona behavior. Review this conversation and identify where the AI fails the keystone standard. For each failure, quote specific evidence from the transcript.

Return valid JSON.`

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    failures: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          principle: { type: SchemaType.STRING, description: 'Which keystone principle the behavior violates' },
          turn: { type: SchemaType.NUMBER, description: 'Which assistant turn (0-indexed) contains the violation' },
          issue: { type: SchemaType.STRING, description: 'What went wrong, concretely' },
          evidence: { type: SchemaType.STRING, description: 'Direct quote from the assistant response as evidence' },
        },
        required: ['principle', 'turn', 'issue', 'evidence'],
      },
    },
    summary: { type: SchemaType.STRING, description: 'One-paragraph summary of behavioral quality' },
  },
  required: ['failures', 'summary'],
}

export async function auditConversation(input: ConversationAuditInput): Promise<ConversationAuditResult> {
  const { apiKey, config, history, context } = input

  const transcript = history.map(msg =>
    `${msg.role.toUpperCase()}: ${msg.content}`
  ).join('\n\n')

  const personaContext = [
    `PERSONA: ${config.identity.name}`,
    `EXPERTISE: ${config.identity.expertise.join(', ')}`,
    `RELATIONSHIP: ${config.identity.relationship}`,
    `NORTH STAR: ${config.identity.northStar}`,
    config.methodology ? `METHODOLOGY:\n${config.methodology}` : '',
  ].filter(Boolean).join('\n')

  const contextStr = context
    ? `\nCONTEXT DATA AVAILABLE TO THE AI:\n${JSON.stringify(context, null, 2)}`
    : ''

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    systemInstruction: CONVERSATION_AUDIT_SYSTEM,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA as unknown as Schema,
    },
  })

  const result = await model.generateContent(
    `${personaContext}${contextStr}\n\nCONVERSATION TO AUDIT:\n${transcript}`
  )

  const parsed = JSON.parse(result.response.text()) as {
    failures: ConversationAuditFailure[]
    summary: string
  }

  return {
    configVersion: configVersion(config),
    failures: parsed.failures ?? [],
    summary: parsed.summary ?? '',
  }
}
