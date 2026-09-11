import { User } from '@apps-in-toss/web-framework'

import { createApiClient, PendingReadingRequestCoordinator } from './client.ts'
import { buildPagePath } from '../features/pagination.ts'
import type {
  AcceptedReading,
  CreatePersonBody,
  CreateReadingBody,
  PatchPersonBody,
  Person,
  PersonList,
  QuestionCatalog,
  ReadingDetail,
  ReadingHistory,
  RelationshipTypeList,
  RetryReadingBody,
  TarotCardCatalog,
} from './types.ts'

export class ClientConfigurationError extends Error {}

export type RecoveredReading = { accepted: AcceptedReading; personId: string }

const resolveBaseUrl = (): string => {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim()
  if (import.meta.env.PROD) {
    if (!configured || !configured.startsWith('https://')) {
      throw new ClientConfigurationError('서비스 연결을 준비하고 있어요. 잠시 뒤 다시 열어 주세요.')
    }
    return configured.replace(/\/$/, '')
  }
  return configured?.replace(/\/$/, '') || '/api'
}

const getLocalKey = (): string => {
  const storageKey = 'tarororo.local-anonymous-key.v1'
  const existing = localStorage.getItem(storageKey)
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(storageKey, created)
  return created
}

const getAnonymousKey = async (): Promise<string> => {
  if (import.meta.env.DEV && import.meta.env.VITE_LOCAL_MOCK_AUTH === 'true') return getLocalKey()
  const result = await User.getAnonymousKey()
  if (result.type !== 'HASH' || !result.hash) throw new Error('익명 사용자 식별키를 가져오지 못했어요.')
  return result.hash
}

export const createBrowserService = () => {
  const transport = createApiClient({ baseUrl: resolveBaseUrl(), getAnonymousKey })
  const pending = new PendingReadingRequestCoordinator({ transport, storage: sessionStorage })
  return {
    listRelationships: () => transport.get<RelationshipTypeList>('/v1/relationship-types'),
    listQuestions: (relationshipCode: string) => transport.get<QuestionCatalog>(`/v1/questions?relationshipCode=${encodeURIComponent(relationshipCode)}`),
    listCards: () => transport.get<TarotCardCatalog>('/v1/cards'),
    listPersons: (cursor?: string | null) => transport.get<PersonList>(buildPagePath('/v1/persons', cursor)),
    getPerson: (personId: string) => transport.get<Person>(`/v1/persons/${encodeURIComponent(personId)}`),
    createPerson: (body: CreatePersonBody) => transport.post<Person>('/v1/persons', body),
    updatePerson: (personId: string, body: PatchPersonBody) => transport.patch<Person>(`/v1/persons/${encodeURIComponent(personId)}`, body),
    listReadings: (personId: string, cursor?: string | null) => transport.get<ReadingHistory>(buildPagePath(`/v1/persons/${encodeURIComponent(personId)}/readings`, cursor)),
    getReading: (readingId: string) => transport.get<ReadingDetail>(`/v1/readings/${encodeURIComponent(readingId)}`),
    createReading: (body: CreateReadingBody) => pending.create<AcceptedReading>(body),
    retryReading: (readingId: string, personId: string, body: RetryReadingBody) => pending.retry<AcceptedReading>(readingId, body, personId),
    resumePendingReading: async (): Promise<RecoveredReading | null> => {
      const recovered = await pending.resumeWithContext<AcceptedReading>()
      if (!recovered) return null
      const personId = recovered.request.personId ?? (await transport.get<ReadingDetail>(`/v1/readings/${encodeURIComponent(recovered.response.readingId)}`)).personId
      return { accepted: recovered.response, personId }
    },
    hasPendingReading: () => pending.hasPending(),
    discardPendingReading: () => pending.discard(),
  }
}

export type BrowserService = ReturnType<typeof createBrowserService>
