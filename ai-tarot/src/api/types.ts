import type { FromSchema } from 'json-schema-to-ts'

import {
  personCreateBodySchema,
  personPatchBodySchema,
  personSchema,
  questionCatalogSchema,
  relationshipTypeListSchema,
  tarotCardCatalogSchema,
} from '../../../contracts/foundation.schemas.ts'
import {
  acceptedReadingSchema,
  createReadingBodySchema,
  readingDetailSchema,
  readingHistorySchema,
  retryReadingBodySchema,
} from '../../../contracts/reading.schemas.ts'

export type Person = FromSchema<typeof personSchema>
export type CreatePersonBody = FromSchema<typeof personCreateBodySchema>
export type PatchPersonBody = FromSchema<typeof personPatchBodySchema>
export type RelationshipTypeList = FromSchema<typeof relationshipTypeListSchema>
export type RelationshipType = RelationshipTypeList['items'][number]
export type QuestionCatalog = FromSchema<typeof questionCatalogSchema>
export type Question = QuestionCatalog['items'][number]
export type TarotCardCatalog = FromSchema<typeof tarotCardCatalogSchema>
export type TarotCard = TarotCardCatalog['items'][number]
export type CreateReadingBody = FromSchema<typeof createReadingBodySchema>
export type RetryReadingBody = FromSchema<typeof retryReadingBodySchema>
export type AcceptedReading = FromSchema<typeof acceptedReadingSchema>
export type ReadingDetail = FromSchema<typeof readingDetailSchema>
export type ReadingHistory = FromSchema<typeof readingHistorySchema>

export type PersonList = {
  items: Person[]
  nextCursor: string | null
}
