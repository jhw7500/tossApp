export const anonymousSessionBodySchema = {
  type: 'object', additionalProperties: false, required: ['anonymousKey'],
  properties: { anonymousKey: { type: 'string', minLength: 1, maxLength: 4096 } },
} as const;

export const personCreateBodySchema = {
  type: 'object', additionalProperties: false, required: ['nickname', 'relationshipCode'],
  properties: {
    nickname: { type: 'string', minLength: 1, maxLength: 120 },
    relationshipCode: { type: 'string', minLength: 1, maxLength: 40 },
    currentSituation: { type: ['string', 'null'], maxLength: 8000 },
  },
} as const;

export const personPatchBodySchema = {
  type: 'object', additionalProperties: false, required: ['version'], minProperties: 2,
  properties: {
    version: { type: 'integer', minimum: 1 },
    nickname: { type: 'string', minLength: 1, maxLength: 120 },
    relationshipCode: { type: 'string', minLength: 1, maxLength: 40 },
    currentSituation: { type: ['string', 'null'], maxLength: 8000 },
  },
} as const;

export const personSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'nickname', 'relationshipCode', 'currentSituation', 'version', 'createdAt', 'updatedAt', 'readingCount', 'lastReadingAt'],
  properties: {
    id: { type: 'string', format: 'uuid' }, nickname: { type: 'string' }, relationshipCode: { type: 'string' },
    currentSituation: { type: ['string', 'null'] }, version: { type: 'integer', minimum: 1 },
    readingCount: { type: 'integer', minimum: 0 }, lastReadingAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const relationshipTypeSchema = {
  type: 'object', additionalProperties: false, required: ['code', 'label'],
  properties: { code: { type: 'string' }, label: { type: 'string' } },
} as const;

export const relationshipTypeListSchema = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: relationshipTypeSchema } },
} as const;

export const cardPositionSchema = {
  type: 'object', additionalProperties: false, required: ['position', 'label', 'description'],
  properties: {
    position: { type: 'integer', minimum: 1, maximum: 3 },
    label: { type: 'string' },
    description: { type: ['string', 'null'] },
  },
} as const;

export const questionCatalogItemSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'version', 'relationshipCode', 'prompt', 'isCustomTemplate', 'positions'],
  properties: {
    id: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 1 },
    relationshipCode: { type: ['string', 'null'] }, prompt: { type: 'string' },
    isCustomTemplate: { type: 'boolean' },
    positions: { type: 'array', minItems: 3, maxItems: 3, items: cardPositionSchema },
  },
} as const;

export const questionCatalogSchema = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: questionCatalogItemSchema } },
} as const;

export const tarotCardCatalogItemSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'code', 'name', 'arcana', 'imageUrl'],
  properties: {
    id: { type: 'string', format: 'uuid' }, code: { type: 'string' }, name: { type: 'string' },
    arcana: { type: 'string' }, imageUrl: { type: ['string', 'null'] },
  },
} as const;

export const tarotCardCatalogSchema = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: tarotCardCatalogItemSchema } },
} as const;
