import { SchemaType } from '@google/generative-ai'
import type { EntityConfig } from '../types.js'

/**
 * Build the crudActions schema fragment for the Gemini response schema.
 *
 * The crudActions array uses a SINGLE generic schema shape (not per-entity anyOf),
 * which is the whole point: eliminating the schema explosion that comes from
 * N entities x 3 operations.
 *
 * Validation against per-entity Zod schemas happens after parsing in crud.ts.
 */
export function buildCrudActionsSchema(
  entities: Record<string, EntityConfig>,
): Record<string, unknown> {
  const entityNames = Object.keys(entities)

  return {
    type: SchemaType.ARRAY,
    description: 'Entity CRUD mutations. Use this array for create/update/delete on declared entities.',
    items: {
      type: SchemaType.OBJECT,
      properties: {
        operation: {
          type: SchemaType.STRING,
          enum: ['create', 'update', 'delete'],
          description: 'The CRUD operation to perform.',
        },
        entity: {
          type: SchemaType.STRING,
          enum: entityNames,
          description: 'Which entity to operate on.',
        },
        id: {
          type: SchemaType.STRING,
          description: 'Entity ID (required for update and delete).',
        },
        params: {
          type: SchemaType.STRING,
          description: `JSON object with entity fields. For create: include all required fields. For update: include only the fields to change. For delete: omit or leave empty. Field names and types are defined in the ENTITIES section of the prompt.`,
        },
      },
      required: ['operation', 'entity'],
    },
  }
}
