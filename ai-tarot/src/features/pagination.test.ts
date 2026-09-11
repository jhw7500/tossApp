import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPagePath, mergePage } from './pagination.ts'

test('a later page appends new records once and adopts its continuation cursor', () => {
  const first = {
    items: [{ id: 'newest', value: 1 }, { id: 'shared', value: 2 }],
    nextCursor: 'first-cursor',
  }
  const later = {
    items: [{ id: 'shared', value: 99 }, { id: 'oldest', value: 3 }, { id: 'oldest', value: 4 }],
    nextCursor: 'later-cursor',
  }

  assert.deepEqual(mergePage(first, later), {
    items: [{ id: 'newest', value: 1 }, { id: 'shared', value: 2 }, { id: 'oldest', value: 3 }],
    nextCursor: 'later-cursor',
  })
})

test('an opaque continuation cursor is encoded without changing the page size', () => {
  assert.equal(
    buildPagePath('/v1/persons', '2026-09-11T00:00:00.000000Z+person/id'),
    '/v1/persons?limit=100&cursor=2026-09-11T00%3A00%3A00.000000Z%2Bperson%2Fid',
  )
  assert.equal(buildPagePath('/v1/persons'), '/v1/persons?limit=100')
})
