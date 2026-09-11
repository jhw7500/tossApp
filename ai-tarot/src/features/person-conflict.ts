import type { PatchPersonBody, Person } from '../api/types.ts'

export type PersonDraft = {
  nickname: string
  relationshipCode: string
  currentSituation: string | null
}

export type PersonConflict = {
  draft: PersonDraft
  latest: Person
}

type ConflictResolution = {
  fields: PersonDraft
  patch: PatchPersonBody | null
}

export function resolvePersonConflict(conflict: PersonConflict, choice: 'keep-draft' | 'use-latest'): ConflictResolution {
  if (choice === 'keep-draft') return {
    fields: conflict.draft,
    patch: { ...conflict.draft, version: conflict.latest.version },
  }
  return {
    fields: {
      nickname: conflict.latest.nickname,
      relationshipCode: conflict.latest.relationshipCode,
      currentSituation: conflict.latest.currentSituation,
    },
    patch: null,
  }
}
