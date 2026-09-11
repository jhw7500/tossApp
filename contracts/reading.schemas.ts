const uuid = { type: 'string', format: 'uuid' } as const;
const version = { type: 'integer', minimum: 1 } as const;
const positionIndex = { type: 'integer', minimum: 1, maximum: 3 } as const;
const nullableText = { type: ['string', 'null'] } as const;
export const readingStatusSchema = { type: 'string', enum: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'] } as const;
export const createReadingBodySchema = {
  type: 'object', additionalProperties: false, required: ['personId', 'personVersion', 'question', 'selections'],
  properties: {
    personId: uuid, personVersion: version,
    question: {
      type: 'object', additionalProperties: false, required: ['id', 'version'],
      properties: { id: uuid, version, customText: { type: 'string', maxLength: 2000 } },
    },
    selections: {
      type: 'array', minItems: 3, maxItems: 3,
      items: { type: 'object', additionalProperties: false, required: ['positionIndex', 'cardId'], properties: { positionIndex, cardId: uuid } },
    },
  },
} as const;
export const retryReadingBodySchema = {
  type: 'object', additionalProperties: false, required: ['expectedAttemptNo'],
  properties: { expectedAttemptNo: { type: 'integer', minimum: 1, maximum: 3 } },
} as const;
export const evidenceReferenceSchema = {
  type: 'object', additionalProperties: false, required: ['interpretationId', 'version'],
  properties: { interpretationId: uuid, version },
} as const;
export const readingResultCardSchema = {
  type: 'object', additionalProperties: false, required: ['positionIndex', 'cardId', 'text', 'evidence'],
  properties: {
    positionIndex, cardId: uuid, text: { type: 'string', minLength: 1, maxLength: 800 },
    evidence: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: evidenceReferenceSchema },
  },
} as const;
export const readingResultSchema = {
  type: 'object', additionalProperties: false, required: ['cards', 'overallReading', 'summary'],
  properties: {
    cards: { type: 'array', minItems: 3, maxItems: 3, items: readingResultCardSchema },
    overallReading: { type: 'string', minLength: 1, maxLength: 2000 },
    summary: { type: 'string', minLength: 1, maxLength: 120 },
  },
} as const;
export const readingCandidateSchema = {
  type: 'object', additionalProperties: false,
  required: ['interpretationId', 'version', 'text', 'sourceKind', 'sourceAttribution'],
  properties: {
    interpretationId: uuid, version, text: { type: 'string', minLength: 1 },
    sourceKind: { type: 'string', enum: ['synthetic_test', 'licensed', 'editorial'] },
    sourceAttribution: { type: 'string' },
  },
} as const;
export const snapshotCardSchema = {
  type: 'object', additionalProperties: false,
  required: ['cardId', 'code', 'name', 'arcana', 'imageUrl', 'positionIndex', 'label', 'description', 'candidates'],
  properties: {
    cardId: uuid, code: { type: 'string' }, name: { type: 'string' }, arcana: { type: 'string' }, imageUrl: nullableText,
    positionIndex, label: { type: 'string' }, description: nullableText,
    candidates: { type: 'array', minItems: 1, maxItems: 20, items: readingCandidateSchema },
  },
} as const;
export const snapshotQuestionSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'version', 'text', 'isCustom'],
  properties: { id: uuid, version, text: { type: 'string' }, isCustom: { type: 'boolean' } },
} as const;
export const readingSnapshotSchema = {
  type: 'object', additionalProperties: false, required: ['person', 'question', 'cards', 'testContent'],
  properties: {
    person: {
      type: 'object', additionalProperties: false,
      required: ['id', 'version', 'nickname', 'relationshipCode', 'currentSituation'],
      properties: { id: uuid, version, nickname: { type: 'string' }, relationshipCode: { type: 'string' }, currentSituation: nullableText },
    },
    question: snapshotQuestionSchema,
    cards: { type: 'array', minItems: 3, maxItems: 3, items: snapshotCardSchema },
    testContent: { type: 'boolean' },
  },
} as const;
// Context is the provider boundary. Person identifiers and nickname stay in the snapshot.
export const readingContextSchema = {
  type: 'object', additionalProperties: false, required: ['relationshipCode', 'currentSituation', 'question', 'cards'],
  properties: {
    relationshipCode: { type: 'string' }, currentSituation: nullableText,
    question: snapshotQuestionSchema,
    cards: { type: 'array', minItems: 3, maxItems: 3, items: snapshotCardSchema },
  },
} as const;
export const acceptedReadingSchema = {
  type: 'object', additionalProperties: false, required: ['readingId', 'status', 'attemptNo', 'statusUrl'],
  properties: { readingId: uuid, status: readingStatusSchema, attemptNo: version, statusUrl: { type: 'string' } },
} as const;
export const readingErrorSchema = {
  type: 'object', additionalProperties: false, required: ['code', 'message', 'retryable'],
  properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } },
} as const;
export const readingInputSchema = {
  type: 'object', additionalProperties: false,
  required: ['personNickname', 'relationshipCode', 'currentSituation', 'question', 'cards'],
  properties: {
    personNickname: { type: 'string' }, relationshipCode: { type: 'string' }, currentSituation: nullableText,
    question: snapshotQuestionSchema,
    cards: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['cardId', 'name', 'positionIndex', 'label'],
      properties: { cardId: uuid, name: { type: 'string' }, positionIndex, label: { type: 'string' } },
    } },
  },
} as const;
export const readingDetailSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'personId', 'status', 'attemptNo', 'createdAt', 'updatedAt', 'input', 'result', 'error', 'aiGenerated', 'testContent'],
  properties: {
    id: uuid, personId: uuid, status: readingStatusSchema, attemptNo: version,
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
    input: readingInputSchema, result: { anyOf: [readingResultSchema, { type: 'null' }] },
    error: { anyOf: [readingErrorSchema, { type: 'null' }] }, aiGenerated: { type: 'boolean' }, testContent: { type: 'boolean' },
  },
} as const;
export const readingHistorySchema = {
  type: 'object', additionalProperties: false, required: ['items', 'nextCursor'],
  properties: {
    nextCursor: nullableText,
    items: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'status', 'question', 'summary', 'createdAt'],
      properties: { id: uuid, status: readingStatusSchema, question: { type: 'string' }, summary: nullableText, createdAt: { type: 'string', format: 'date-time' } },
    } },
  },
} as const;
