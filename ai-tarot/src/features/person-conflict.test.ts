import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePersonConflict } from './person-conflict.ts'

const draft = { nickname: '내가 쓴 별명', relationshipCode: 'crush', currentSituation: '내가 쓴 상황' }
const latest = {
  id: '00000000-0000-4000-8000-000000000001', nickname: '서버 별명', relationshipCode: 'dating', currentSituation: '서버 상황',
  version: 4, createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:01:00.000Z', readingCount: 0, lastReadingAt: null,
}

test('keeping the draft resubmits every draft field against the latest server version', () => {
  assert.deepEqual(resolvePersonConflict({ draft, latest }, 'keep-draft'), {
    fields: draft,
    patch: { ...draft, version: 4 },
  })
})

test('adopting latest replaces fields only after the explicit choice', () => {
  assert.deepEqual(resolvePersonConflict({ draft, latest }, 'use-latest'), {
    fields: { nickname: '서버 별명', relationshipCode: 'dating', currentSituation: '서버 상황' },
    patch: null,
  })
})
