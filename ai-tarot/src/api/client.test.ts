import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  createApiClient,
  PendingRequestConflictError,
  PendingReadingRequestCoordinator,
  type KeyValueStorage,
} from './client.ts'
import { toggleCardSelection, validateReadingForm } from '../features/reading-form.ts'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('a 401 re-identifies once and repeats the original body and idempotency key', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const responses = [
    jsonResponse({ token: 'token-one', expiresAt: '2099-01-01T00:00:00.000Z' }, 201),
    jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired', retryable: false, requestId: 'r1' } }, 401),
    jsonResponse({ token: 'token-two', expiresAt: '2099-01-01T00:00:00.000Z' }, 201),
    jsonResponse({ readingId: '00000000-0000-4000-8000-000000000001', status: 'QUEUED', attemptNo: 1, statusUrl: '/v1/readings/00000000-0000-4000-8000-000000000001' }, 202),
  ]
  let keyCalls = 0
  const client = createApiClient({
    baseUrl: 'https://api.example.test',
    getAnonymousKey: async () => `anonymous-${++keyCalls}`,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return responses.shift()!
    },
  })
  const body = { personId: 'person', selections: [{ positionIndex: 1, cardId: 'card' }] }

  await client.post('/v1/readings', body, { idempotencyKey: '00000000-0000-4000-8000-000000000010' })

  assert.equal(keyCalls, 2)
  const readingCalls = calls.filter(({ url }) => url.endsWith('/v1/readings'))
  assert.equal(readingCalls.length, 2)
  assert.equal(readingCalls[0]?.init?.body, JSON.stringify(body))
  assert.equal(readingCalls[1]?.init?.body, JSON.stringify(body))
  assert.equal(new Headers(readingCalls[0]?.init?.headers).get('idempotency-key'), '00000000-0000-4000-8000-000000000010')
  assert.equal(new Headers(readingCalls[1]?.init?.headers).get('idempotency-key'), '00000000-0000-4000-8000-000000000010')
})

test('a second 401 is exposed as a structured error without a third identification', async () => {
  const responses = [
    jsonResponse({ token: 'token-one', expiresAt: '2099-01-01T00:00:00.000Z' }, 201),
    jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired', retryable: false, requestId: 'r1' } }, 401),
    jsonResponse({ token: 'token-two', expiresAt: '2099-01-01T00:00:00.000Z' }, 201),
    jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'still expired', retryable: false, requestId: 'r2' } }, 401),
  ]
  let keyCalls = 0
  const client = createApiClient({
    baseUrl: 'https://api.example.test',
    getAnonymousKey: async () => `anonymous-${++keyCalls}`,
    fetch: async () => responses.shift()!,
  })

  await assert.rejects(
    client.get('/v1/persons'),
    (error: unknown) => error instanceof ApiError && error.status === 401 && error.code === 'UNAUTHORIZED' && error.requestId === 'r2',
  )
  assert.equal(keyCalls, 2)
})

test('parallel first requests share one in-flight identification', async () => {
  let sessionCalls = 0
  let resourceCalls = 0
  const client = createApiClient({
    baseUrl: 'https://api.example.test',
    getAnonymousKey: async () => 'anonymous-key',
    fetch: async (url) => {
      if (String(url).endsWith('/v1/sessions/toss-anonymous')) {
        sessionCalls += 1
        await Promise.resolve()
        return jsonResponse({ token: 'shared-token', expiresAt: '2099-01-01T00:00:00.000Z' }, 201)
      }
      resourceCalls += 1
      return jsonResponse({ items: [] })
    },
  })

  await Promise.all([client.get('/v1/persons'), client.get('/v1/relationship-types')])

  assert.equal(sessionCalls, 1)
  assert.equal(resourceCalls, 2)
})

test('parallel stale 401 responses cause only one refresh generation', async () => {
  let sessionCalls = 0
  let oldTokenCalls = 0
  let releaseLateResponse!: () => void
  let announceRefresh!: () => void
  const lateResponse = new Promise<void>(resolve => { releaseLateResponse = resolve })
  const refreshStarted = new Promise<void>(resolve => { announceRefresh = resolve })
  const client = createApiClient({
    baseUrl: 'https://api.example.test',
    getAnonymousKey: async () => 'anonymous-key',
    fetch: async (url, init) => {
      if (String(url).endsWith('/v1/sessions/toss-anonymous')) {
        sessionCalls += 1
        if (sessionCalls === 2) announceRefresh()
        return jsonResponse({ token: `token-${sessionCalls}`, expiresAt: '2099-01-01T00:00:00.000Z' }, 201)
      }
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === 'Bearer token-1') {
        oldTokenCalls += 1
        if (oldTokenCalls === 2) await lateResponse
        return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired', retryable: false } }, 401)
      }
      assert.equal(authorization, 'Bearer token-2')
      return jsonResponse({ items: [] })
    },
  })

  const requests = Promise.all([client.get('/v1/persons'), client.get('/v1/cards')])
  await refreshStarted
  releaseLateResponse()
  await requests

  assert.equal(sessionCalls, 2)
})

class MemoryStorage implements KeyValueStorage {
  value: string | null = null
  getItem() { return this.value }
  setItem(_key: string, value: string) { this.value = value }
  removeItem() { this.value = null }
}

test('an uncertain create is stored before send and resumed with the same key and body', async () => {
  const storage = new MemoryStorage()
  const sent: Array<{ path: string; body: unknown; key: string; storedAtSend: string | null }> = []
  let fail = true
  const transport = {
    post: async <T>(path: string, body: unknown, options: { idempotencyKey: string }): Promise<T> => {
      sent.push({ path, body, key: options.idempotencyKey, storedAtSend: storage.value })
      if (fail) throw new TypeError('network lost')
      return { readingId: '00000000-0000-4000-8000-000000000001', status: 'QUEUED', attemptNo: 1, statusUrl: '/status' } as T
    },
  }
  const first = new PendingReadingRequestCoordinator({ transport, storage, createKey: () => '00000000-0000-4000-8000-000000000020' })
  const body = { personId: 'person-1', personVersion: 3, question: { id: 'question-1', version: 2 }, selections: [] }

  await assert.rejects(first.create(body), TypeError)
  assert.ok(sent[0]?.storedAtSend)
  assert.ok(storage.value)
  assert.equal(first.hasPending(), true)

  fail = false
  const afterReload = new PendingReadingRequestCoordinator({ transport, storage, createKey: () => 'unused' })
  const recovered = await afterReload.resumeWithContext()

  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1]?.body, body)
  assert.equal(sent[1]?.key, '00000000-0000-4000-8000-000000000020')
  assert.deepEqual(recovered?.request.body, body)
  assert.equal((recovered?.response as { readingId: string }).readingId, '00000000-0000-4000-8000-000000000001')
  assert.equal(storage.value, null)
  assert.equal(afterReload.hasPending(), false)
})

test('a lost accepted create survives session rate limiting and recovers the same Reading envelope', async () => {
  const storage = new MemoryStorage()
  const readingId = '00000000-0000-4000-8000-000000000031'
  const idempotencyKey = '00000000-0000-4000-8000-000000000032'
  const accepted = { readingId, status: 'QUEUED', attemptNo: 1, statusUrl: `/v1/readings/${readingId}` }
  const bodies: string[] = []
  const keys: string[] = []
  const readingsByKey = new Map<string, typeof accepted>()
  let sessionCalls = 0
  let readingCalls = 0
  const client = createApiClient({
    baseUrl: 'https://api.example.test',
    getAnonymousKey: async () => 'anonymous-key',
    fetch: async (url, init) => {
      if (String(url).endsWith('/v1/sessions/toss-anonymous')) {
        sessionCalls += 1
        if (sessionCalls === 2) return jsonResponse({ error: { code: 'RATE_LIMITED', message: 'identify later', retryable: true } }, 429)
        return jsonResponse({ token: `token-${sessionCalls}`, expiresAt: '2099-01-01T00:00:00.000Z' }, 201)
      }
      readingCalls += 1
      bodies.push(String(init?.body))
      const key = new Headers(init?.headers).get('idempotency-key')!
      keys.push(key)
      if (readingCalls === 1) {
        readingsByKey.set(key, accepted)
        throw new TypeError('response lost after acceptance')
      }
      if (readingCalls === 2) return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired', retryable: false } }, 401)
      return jsonResponse(readingsByKey.get(key), 200)
    },
  })
  const coordinator = new PendingReadingRequestCoordinator({ transport: client, storage, createKey: () => idempotencyKey })
  const body = { personId: 'person-original', personVersion: 4, question: { id: 'question-original', version: 2 }, selections: [] }

  await assert.rejects(coordinator.create(body), TypeError)
  await assert.rejects(coordinator.resume(), (error: unknown) => error instanceof ApiError && error.status === 429)
  assert.equal(coordinator.hasPending(), true)

  const recovered = await coordinator.resume<typeof accepted>()
  assert.equal(recovered?.readingId, readingId)
  assert.equal(readingsByKey.size, 1)
  assert.deepEqual(bodies, [JSON.stringify(body), JSON.stringify(body), JSON.stringify(body)])
  assert.deepEqual(keys, [idempotencyKey, idempotencyKey, idempotencyKey])
  assert.equal(coordinator.hasPending(), false)
})

test('an exhausted authentication refresh preserves a lost accepted create for later replay', async () => {
  const storage = new MemoryStorage()
  const idempotencyKey = '00000000-0000-4000-8000-000000000042'
  const readingId = '00000000-0000-4000-8000-000000000041'
  let sessionCalls = 0
  let readingCalls = 0
  const client = createApiClient({
    baseUrl: 'https://api.example.test',
    getAnonymousKey: async () => 'anonymous-key',
    fetch: async (url) => {
      if (String(url).endsWith('/v1/sessions/toss-anonymous')) {
        sessionCalls += 1
        return jsonResponse({ token: `token-${sessionCalls}`, expiresAt: '2099-01-01T00:00:00.000Z' }, 201)
      }
      readingCalls += 1
      if (readingCalls === 1) throw new TypeError('response lost after acceptance')
      if (readingCalls <= 3) return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired', retryable: false } }, 401)
      return jsonResponse({ readingId, status: 'QUEUED', attemptNo: 1, statusUrl: `/v1/readings/${readingId}` }, 200)
    },
  })
  const coordinator = new PendingReadingRequestCoordinator({ transport: client, storage, createKey: () => idempotencyKey })
  const body = { personId: 'person-original', question: { id: 'question-original', version: 2 } }

  await assert.rejects(coordinator.create(body), TypeError)
  await assert.rejects(coordinator.resume(), (error: unknown) => error instanceof ApiError && error.status === 401)
  assert.equal(coordinator.hasPending(), true)
  assert.equal((await coordinator.resume<{ readingId: string }>())?.readingId, readingId)
  assert.equal(coordinator.hasPending(), false)
})

test('a Reading endpoint rate limit is authoritative and clears its pending envelope', async () => {
  const storage = new MemoryStorage()
  const client = createApiClient({
    baseUrl: 'https://api.example.test',
    getAnonymousKey: async () => 'anonymous-key',
    fetch: async (url) => String(url).endsWith('/v1/sessions/toss-anonymous')
      ? jsonResponse({ token: 'token-1', expiresAt: '2099-01-01T00:00:00.000Z' }, 201)
      : jsonResponse({ error: { code: 'RATE_LIMITED', message: 'another Reading is active', retryable: true } }, 429),
  })
  const coordinator = new PendingReadingRequestCoordinator({ transport: client, storage, createKey: () => '00000000-0000-4000-8000-000000000052' })

  await assert.rejects(coordinator.create({ personId: 'person-1' }), (error: unknown) => error instanceof ApiError && error.status === 429)
  assert.equal(coordinator.hasPending(), false)
})

test('retrying the same uncertain request reuses its envelope while changed input is rejected', async () => {
  const storage = new MemoryStorage()
  const sentKeys: string[] = []
  const transport = {
    post: async <T>(_path: string, _body: unknown, options: { idempotencyKey: string }): Promise<T> => {
      sentKeys.push(options.idempotencyKey)
      throw new TypeError('network lost')
    },
  }
  let keys = 0
  const coordinator = new PendingReadingRequestCoordinator({ transport, storage, createKey: () => `key-${++keys}` })
  const original = { personId: 'person-1', question: { id: 'q1', version: 1 } }
  await assert.rejects(coordinator.create(original), TypeError)
  await assert.rejects(coordinator.create(original), TypeError)
  await assert.rejects(coordinator.create({ ...original, question: { id: 'q2', version: 1 } }), PendingRequestConflictError)

  assert.deepEqual(sentKeys, ['key-1', 'key-1'])
  assert.equal(keys, 1)
  assert.match(storage.value ?? '', /key-1/)
  assert.doesNotMatch(storage.value ?? '', /q2/)
})

test('ambiguous server failures preserve pending while definitive rejection clears it', async () => {
  const storage = new MemoryStorage()
  let status = 503
  const transport = {
    post: async <T>(): Promise<T> => { throw new ApiError(status, { code: status === 503 ? 'INTERNAL_ERROR' : 'INVALID_INPUT', message: 'failure', retryable: false }) },
  }
  const coordinator = new PendingReadingRequestCoordinator({ transport, storage, createKey: () => 'key-1' })
  await assert.rejects(coordinator.create({ personId: 'person-1' }), ApiError)
  assert.ok(storage.value)

  status = 400
  await assert.rejects(coordinator.resume(), ApiError)
  assert.equal(storage.value, null)
})

test('parallel recovery calls share one send for the pending idempotency key', async () => {
  const storage = new MemoryStorage()
  let sends = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const transport = {
    post: async <T>(): Promise<T> => {
      sends += 1
      if (sends === 1) throw new TypeError('network lost')
      await gate
      return { readingId: 'reading-1' } as T
    },
  }
  const coordinator = new PendingReadingRequestCoordinator({ transport, storage, createKey: () => 'key-1' })
  await assert.rejects(coordinator.create({ personId: 'person-1' }), TypeError)

  const first = coordinator.resume()
  const second = coordinator.resume()
  release()
  await Promise.all([first, second])

  assert.equal(sends, 2)
})

test('a late completed send does not clear a newer pending envelope', async () => {
  const storage = new MemoryStorage()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const transport = { post: async <T>(): Promise<T> => { await gate; return { readingId: 'old-reading' } as T } }
  const coordinator = new PendingReadingRequestCoordinator({ transport, storage, createKey: () => 'old-key' })
  const oldRequest = coordinator.create({ personId: 'old-person' })
  storage.setItem('tarororo.pending-reading-request.v1', JSON.stringify({ version: 1, path: '/v1/readings', body: { personId: 'new-person' }, idempotencyKey: 'new-key' }))
  release()
  await oldRequest

  assert.match(storage.value ?? '', /new-key/)
})

test('reading form requires the DB positions and rejects duplicate cards and invalid custom text', () => {
  const positions = [{ position: 1 }, { position: 2 }, { position: 3 }]
  assert.equal(validateReadingForm({ questionId: '', isCustomTemplate: false, customText: '', positions, selections: {} }).valid, false)
  assert.equal(validateReadingForm({ questionId: 'q1', isCustomTemplate: false, customText: '', positions, selections: { 1: 'a', 2: 'a', 3: 'c' } }).code, 'DUPLICATE_CARD')
  assert.equal(validateReadingForm({ questionId: 'q1', isCustomTemplate: true, customText: ' ', positions, selections: { 1: 'a', 2: 'b', 3: 'c' } }).code, 'CUSTOM_REQUIRED')
  assert.equal(validateReadingForm({ questionId: 'q1', isCustomTemplate: true, customText: '가'.repeat(501), positions, selections: { 1: 'a', 2: 'b', 3: 'c' } }).code, 'CUSTOM_TOO_LONG')
  assert.deepEqual(validateReadingForm({ questionId: 'q1', isCustomTemplate: true, customText: ' 앞으로 어떻게 될까? ', positions, selections: { 1: 'a', 2: 'b', 3: 'c' } }), { valid: true, code: null })
})

test('tapping the current card clears its position so a completed spread can be changed', () => {
  assert.deepEqual(toggleCardSelection({ 1: 'card-a', 2: 'card-b', 3: 'card-c' }, 2, 'card-b'), { 1: 'card-a', 3: 'card-c' })
  assert.deepEqual(toggleCardSelection({ 1: 'card-a' }, 2, 'card-b'), { 1: 'card-a', 2: 'card-b' })
})
