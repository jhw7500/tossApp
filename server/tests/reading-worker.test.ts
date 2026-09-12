import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { ReadingContext, ReadingResult, ReadingUsage } from '../src/readings/types.ts';
import type { GenerateReadingInput, ReadingProvider } from '../src/ai/types.ts';
import { AiProviderError } from '../src/ai/types.ts';
import { runWorker } from '../src/worker/run.ts';
import { claimNextReading, expireReadings } from '../src/readings/attempts.ts';
import { readingFixture } from './helpers.ts';

function grounded(context: ReadingContext): ReadingResult {
  return {
    cards: context.cards.map(card => ({ positionIndex: card.positionIndex, cardId: card.cardId, text: `${card.name}의 원문에 따른 해석`, evidence: [{ interpretationId: card.candidates[0].interpretationId, version: card.candidates[0].version }] })),
    overallReading: '세 카드의 근거를 이어 관계의 흐름을 살펴봅니다.', summary: '근거에 따라 천천히 살펴보세요.',
  };
}

async function waitForStatus(app: Awaited<ReturnType<typeof readingFixture>>['app'], headers: Record<string, string>, id: string, status: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await app.inject({ url: `/v1/readings/${id}`, headers });
    if (response.json().status === status) return response.json();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`reading did not reach ${status}`);
}

test('worker claims an existing queue item once and persists a grounded result', async () => {
  const fixture = await readingFixture();
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    let calls = 0;
    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate(input: GenerateReadingInput) { calls++; return { result: grounded(input.context), usage: { totalTokens: 42 } }; } };
    const controller = new AbortController();
    const running = runWorker({ pool: fixture.pool, provider, signal: controller.signal, pollIntervalMs: 5 });
    const detail = await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'SUCCEEDED');
    controller.abort(); await running;
    assert.equal(calls, 1);
    assert.equal(detail.aiGenerated, false);
    assert.deepEqual(detail.result.cards.map((card: { positionIndex: number }) => card.positionIndex), [1, 2, 3]);
    const attempt = await fixture.pool.query('SELECT provider, model, usage FROM reading_attempts WHERE reading_id = $1', [created.json().readingId]);
    assert.deepEqual(attempt.rows[0], { provider: 'fixture', model: 'fixture-v1', usage: { totalTokens: 42 } });
  } finally { await fixture.close(); }
});

test('worker emits bounded lifecycle metadata for a successful attempt', async () => {
  const fixture = await readingFixture();
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    const usage = { inputTokens: -1, totalTokens: 42, privateProviderTrace: 'private usage metadata' } as unknown as ReadingUsage;
    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate(input) { return { result: grounded(input.context), usage }; } };
    const events: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const running = runWorker({
      pool: fixture.pool,
      provider,
      signal: controller.signal,
      pollIntervalMs: 5,
      onEvent(event) { events.push(event); },
    });
    await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'SUCCEEDED');
    controller.abort(); await running;

    assert.equal(events.length, 2);
    assert.deepEqual(Object.keys(events[0]).sort(), ['attemptId', 'attemptNo', 'event', 'model', 'provider', 'readingId'].sort());
    assert.equal(events[0].event, 'reading_attempt_started');
    assert.equal(events[0].readingId, created.json().readingId);
    assert.equal(events[0].attemptNo, 1);
    assert.equal(events[0].provider, 'fixture');
    assert.equal(events[0].model, 'fixture-v1');

    assert.deepEqual(Object.keys(events[1]).sort(), ['attemptId', 'attemptNo', 'durationMs', 'event', 'model', 'provider', 'readingId', 'status', 'usage'].sort());
    assert.equal(events[1].event, 'reading_attempt_finished');
    assert.equal(events[1].attemptId, events[0].attemptId);
    assert.equal(events[1].status, 'SUCCEEDED');
    assert.deepEqual(events[1].usage, { totalTokens: 42 });
    assert.equal(Number.isFinite(events[1].durationMs) && Number(events[1].durationMs) >= 0, true);

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(fixture.person.currentSituation), false);
    assert.equal(serialized.includes('원문에 따른 해석'), false);
    assert.equal(serialized.includes('private usage metadata'), false);
    const attempt = await fixture.pool.query('SELECT usage FROM reading_attempts WHERE reading_id = $1', [created.json().readingId]);
    assert.deepEqual(attempt.rows[0].usage, { totalTokens: 42 });
  } finally { await fixture.close(); }
});

test('worker emits only a safe error code for a failed attempt', async () => {
  const fixture = await readingFixture();
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate() { throw new AiProviderError('AI_RATE_LIMITED', true, 'private raw response'); } };
    const events: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const running = runWorker({
      pool: fixture.pool,
      provider,
      signal: controller.signal,
      pollIntervalMs: 5,
      onEvent(event) { events.push(event); },
    });
    await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'FAILED');
    controller.abort(); await running;

    assert.equal(events.length, 2);
    assert.deepEqual(Object.keys(events[1]).sort(), ['attemptId', 'attemptNo', 'durationMs', 'errorCode', 'event', 'model', 'provider', 'readingId', 'status'].sort());
    assert.equal(events[1].status, 'FAILED');
    assert.equal(events[1].errorCode, 'AI_RATE_LIMITED');
    assert.equal(Number.isFinite(events[1].durationMs) && Number(events[1].durationMs) >= 0, true);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes('private raw response'), false);
    assert.equal(serialized.includes(fixture.person.currentSituation), false);
  } finally { await fixture.close(); }
});

test('worker normalizes malformed provider error codes before logging', async () => {
  const fixture = await readingFixture();
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate() { throw new AiProviderError('private provider code: account-42', true); } };
    const events: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const running = runWorker({
      pool: fixture.pool,
      provider,
      signal: controller.signal,
      pollIntervalMs: 5,
      onEvent(event) { events.push(event); },
    });
    const detail = await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'FAILED');
    controller.abort(); await running;

    assert.equal(detail.error.code, 'AI_UNAVAILABLE');
    assert.equal(events[1].errorCode, 'AI_UNAVAILABLE');
    assert.equal(JSON.stringify(events).includes('account-42'), false);
  } finally { await fixture.close(); }
});

test('worker event observer failures never change the reading outcome', async () => {
  const fixture = await readingFixture();
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    let calls = 0;
    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate(input) { calls++; return { result: grounded(input.context), usage: null }; } };
    running = runWorker({
      pool: fixture.pool,
      provider,
      signal: controller.signal,
      pollIntervalMs: 5,
      onEvent() { throw new Error('logger unavailable'); },
    });
    const outcome = await Promise.race([
      waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'SUCCEEDED').then(detail => ({ kind: 'status' as const, detail })),
      running.then(() => ({ kind: 'stopped' as const }), error => ({ kind: 'error' as const, error })),
    ]);

    assert.equal(outcome.kind, 'status');
    assert.equal(calls, 1);
    controller.abort();
    await running;
  } finally {
    controller.abort();
    await running?.catch(() => undefined);
    await fixture.close();
  }
});

test('worker isolates rejected asynchronous event observers', async () => {
  const fixture = await readingFixture();
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    let calls = 0;
    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate(input) { calls++; return { result: grounded(input.context), usage: null }; } };
    running = runWorker({
      pool: fixture.pool,
      provider,
      signal: controller.signal,
      pollIntervalMs: 5,
      async onEvent() { throw new Error('async logger unavailable'); },
    });
    await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'SUCCEEDED');
    controller.abort();
    await running;
    assert.equal(calls, 1);
  } finally {
    controller.abort();
    await running?.catch(() => undefined);
    await fixture.close();
  }
});

test('worker records one safe failure and only an explicit retry calls the next provider', async () => {
  const fixture = await readingFixture();
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    let failedCalls = 0;
    const failedProvider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate() { failedCalls++; throw new AiProviderError('AI_RATE_LIMITED', true, 'private raw response'); } };
    const firstController = new AbortController();
    const firstRun = runWorker({ pool: fixture.pool, provider: failedProvider, signal: firstController.signal, pollIntervalMs: 5 });
    const failed = await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'FAILED');
    firstController.abort(); await firstRun;
    assert.equal(failedCalls, 1);
    assert.deepEqual(failed.error, { code: 'AI_RATE_LIMITED', message: 'reading could not be completed', retryable: true });

    const retry = await fixture.app.inject({ method: 'POST', url: `/v1/readings/${created.json().readingId}/retry`, headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: { expectedAttemptNo: 1 } });
    assert.equal(retry.statusCode, 202);
    let successCalls = 0;
    const successfulProvider: ReadingProvider = { name: 'fixture', model: 'fixture-v2', aiGenerated: false, async generate(input) { successCalls++; return { result: grounded(input.context), usage: null }; } };
    const secondController = new AbortController();
    const secondRun = runWorker({ pool: fixture.pool, provider: successfulProvider, signal: secondController.signal, pollIntervalMs: 5 });
    await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'SUCCEEDED');
    secondController.abort(); await secondRun;
    assert.equal(successCalls, 1);
  } finally { await fixture.close(); }
});

test('worker aborts an in-flight provider and stops claiming new work', async () => {
  const fixture = await readingFixture();
  try {
    await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    let observedAbort = false;
    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate(input) {
      await new Promise<void>(resolve => input.signal?.addEventListener('abort', () => { observedAbort = true; resolve(); }, { once: true }));
      throw new AiProviderError('AI_CANCELLED', true);
    } };
    const controller = new AbortController();
    const running = runWorker({ pool: fixture.pool, provider, signal: controller.signal, pollIntervalMs: 5 });
    await waitForStatus(fixture.app, fixture.headers, (await fixture.pool.query('SELECT id FROM readings')).rows[0].id, 'RUNNING');
    controller.abort(); await running;
    assert.equal(observedAbort, true);
  } finally { await fixture.close(); }
});

test('malformed output requires an explicit retry and then succeeds on the same frozen Reading', async () => {
  const fixture = await readingFixture();
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    const readingId = created.json().readingId;
    const before = (await fixture.pool.query('SELECT request_snapshot FROM readings WHERE id = $1', [readingId])).rows[0].request_snapshot;
    const evidenceBefore = (await fixture.pool.query(`
      SELECT c.card_id, c.position_index, e.interpretation_id, e.version, e.text_snapshot, e.metadata_snapshot
      FROM reading_cards c JOIN reading_evidence e ON e.reading_card_id = c.id
      WHERE c.reading_id = $1 ORDER BY c.position_index, e.interpretation_id, e.version
    `, [readingId])).rows;
    let calls = 0;
    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate(input) {
      calls += 1;
      if (calls > 1) return { result: grounded(input.context), usage: null };
      const result = grounded(input.context) as ReadingResult & { unexpected?: boolean };
      result.unexpected = true;
      return { result, usage: null };
    } };
    const controller = new AbortController();
    const running = runWorker({ pool: fixture.pool, provider, signal: controller.signal, pollIntervalMs: 5 });
    try {
      const failed = await waitForStatus(fixture.app, fixture.headers, readingId, 'FAILED');
      assert.deepEqual(failed.error, { code: 'AI_OUTPUT_INVALID', message: 'reading could not be completed', retryable: true });
      assert.equal(failed.result, null);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(calls, 1);
      assert.equal((await fixture.pool.query('SELECT result_json FROM readings WHERE id = $1', [readingId])).rows[0].result_json, null);
      assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM reading_evidence e JOIN reading_cards c ON c.id = e.reading_card_id WHERE c.reading_id = $1 AND e.selected', [readingId])).rows[0].count, 0);

      const retry = await fixture.app.inject({ method: 'POST', url: `/v1/readings/${readingId}/retry`, headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: { expectedAttemptNo: 1 } });
      assert.equal(retry.statusCode, 202);
      assert.equal(retry.json().readingId, readingId);
      const succeeded = await waitForStatus(fixture.app, fixture.headers, readingId, 'SUCCEEDED');

      assert.equal(calls, 2);
      assert.equal(succeeded.attemptNo, 2);
      assert.deepEqual(succeeded.input, failed.input);
      const after = (await fixture.pool.query('SELECT request_snapshot FROM readings WHERE id = $1', [readingId])).rows[0].request_snapshot;
      const evidenceAfter = (await fixture.pool.query(`
        SELECT c.card_id, c.position_index, e.interpretation_id, e.version, e.text_snapshot, e.metadata_snapshot
        FROM reading_cards c JOIN reading_evidence e ON e.reading_card_id = c.id
        WHERE c.reading_id = $1 ORDER BY c.position_index, e.interpretation_id, e.version
      `, [readingId])).rows;
      assert.deepEqual(after, before);
      assert.deepEqual(evidenceAfter, evidenceBefore);
      assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM reading_attempts WHERE reading_id = $1', [readingId])).rows[0].count, 2);
    } finally {
      controller.abort();
      await running;
    }
  } finally { await fixture.close(); }
});

test('a restarted worker processes an explicit retry after the abandoned lease expires', async () => {
  const fixture = await readingFixture();
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    const abandoned = await claimNextReading(fixture.pool, { provider: 'old-worker', model: 'old-model' });
    assert.equal(abandoned?.readingId, created.json().readingId);
    await fixture.pool.query("UPDATE reading_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [abandoned!.attemptId]);
    assert.equal(await expireReadings(fixture.pool), 1);
    const retry = await fixture.app.inject({ method: 'POST', url: `/v1/readings/${created.json().readingId}/retry`, headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: { expectedAttemptNo: 1 } });
    assert.equal(retry.statusCode, 202);

    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate(input) { return { result: grounded(input.context), usage: null }; } };
    const controller = new AbortController();
    const running = runWorker({ pool: fixture.pool, provider, signal: controller.signal, pollIntervalMs: 5 });
    const detail = await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'SUCCEEDED');
    controller.abort(); await running;
    assert.equal(detail.attemptNo, 2);
  } finally { await fixture.close(); }
});

test('late provider completion cannot replace an expired attempt', async () => {
  const fixture = await readingFixture();
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider: ReadingProvider = { name: 'fixture', model: 'slow-v1', aiGenerated: false, async generate(input) { await gate; return { result: grounded(input.context), usage: null }; } };
    const events: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const running = runWorker({
      pool: fixture.pool,
      provider,
      signal: controller.signal,
      concurrency: 1,
      pollIntervalMs: 5,
      onEvent(event) { events.push(event); },
    });
    await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'RUNNING');
    await fixture.pool.query("UPDATE reading_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE reading_id = $1", [created.json().readingId]);
    assert.equal(await expireReadings(fixture.pool), 1);
    release();
    const failed = await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'FAILED');
    controller.abort(); await running;
    assert.equal(failed.error.code, 'WORKER_TIMEOUT');
    assert.equal(failed.result, null);
    assert.equal(events.length, 2);
    assert.deepEqual(Object.keys(events[1]).sort(), ['attemptId', 'attemptNo', 'durationMs', 'event', 'model', 'provider', 'readingId', 'status'].sort());
    assert.equal(events[1].status, 'STALE');
    assert.equal(events[1].attemptId, events[0].attemptId);
    assert.equal(Number.isFinite(events[1].durationMs) && Number(events[1].durationMs) >= 0, true);
  } finally { await fixture.close(); }
});

test('late provider failure is reported as stale without leaking its error', async () => {
  const fixture = await readingFixture();
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider: ReadingProvider = { name: 'fixture', model: 'slow-v1', aiGenerated: false, async generate() { await gate; throw new AiProviderError('AI_RATE_LIMITED', true, 'private stale failure'); } };
    const events: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const running = runWorker({
      pool: fixture.pool,
      provider,
      signal: controller.signal,
      concurrency: 1,
      pollIntervalMs: 5,
      onEvent(event) { events.push(event); },
    });
    await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'RUNNING');
    await fixture.pool.query("UPDATE reading_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE reading_id = $1", [created.json().readingId]);
    assert.equal(await expireReadings(fixture.pool), 1);
    release();
    await waitForStatus(fixture.app, fixture.headers, created.json().readingId, 'FAILED');
    controller.abort(); await running;

    assert.equal(events.length, 2);
    assert.equal(events[1].status, 'STALE');
    assert.equal('errorCode' in events[1], false);
    assert.equal(JSON.stringify(events).includes('private stale failure'), false);
  } finally { await fixture.close(); }
});

test('worker aborts and drains another active provider when persistence makes the loop exit', async () => {
  const fixture = await readingFixture();
  const caller = new AbortController();
  try {
    const first = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    const session = await fixture.app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey: randomUUID() } });
    const secondHeaders = { authorization: `Bearer ${session.json().token}` };
    const person = (await fixture.app.inject({ method: 'POST', url: '/v1/persons', headers: secondHeaders, payload: { nickname: '서연', relationshipCode: 'crush', currentSituation: '두 번째 작업' } })).json();
    const secondBody = { ...fixture.body, personId: person.id, personVersion: person.version };
    const second = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...secondHeaders, 'idempotency-key': randomUUID() }, payload: secondBody });
    const secondId = second.json().readingId as string;
    await fixture.pool.query(`
      CREATE FUNCTION reject_second_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.reading_id = '${secondId}'::uuid AND NEW.status IN ('SUCCEEDED', 'FAILED') THEN
          RAISE EXCEPTION 'injected persistence failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_second_attempt BEFORE UPDATE ON reading_attempts
      FOR EACH ROW EXECUTE FUNCTION reject_second_attempt()
    `);
    let aborted = false;
    let drained = false;
    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate(input) {
      if (input.context.currentSituation === fixture.person.currentSituation) {
        await new Promise<void>(resolve => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
        aborted = true;
        drained = true;
        throw new AiProviderError('AI_CANCELLED', true);
      }
      return { result: grounded(input.context), usage: null };
    } };
    const running = runWorker({ pool: fixture.pool, provider, signal: caller.signal, concurrency: 2, pollIntervalMs: 5 });
    const outcome = await Promise.race([running.then(() => 'resolved', () => 'rejected'), new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 500))]);
    assert.equal(outcome, 'rejected');
    assert.equal(aborted, true);
    assert.equal(drained, true);
    assert.equal(first.statusCode, 202);
  } finally {
    caller.abort();
    await new Promise(resolve => setTimeout(resolve, 20));
    await fixture.close();
  }
});

test('worker retains a processing failure while the next database claim is delayed', async () => {
  const fixture = await readingFixture();
  const caller = new AbortController();
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>(resolve => { releaseClaim = resolve; });
  try {
    const created = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, payload: fixture.body });
    const readingId = created.json().readingId as string;
    const session = await fixture.app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey: randomUUID() } });
    const secondHeaders = { authorization: `Bearer ${session.json().token}` };
    const secondPerson = (await fixture.app.inject({ method: 'POST', url: '/v1/persons', headers: secondHeaders, payload: { nickname: '하린', relationshipCode: 'crush', currentSituation: '지연된 다음 claim' } })).json();
    const second = await fixture.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...secondHeaders, 'idempotency-key': randomUUID() }, payload: { ...fixture.body, personId: secondPerson.id, personVersion: secondPerson.version } });
    await fixture.pool.query(`
      CREATE FUNCTION reject_only_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.reading_id = '${readingId}'::uuid AND NEW.status IN ('SUCCEEDED', 'FAILED') THEN
          RAISE EXCEPTION 'injected processing failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_only_attempt BEFORE UPDATE ON reading_attempts
      FOR EACH ROW EXECUTE FUNCTION reject_only_attempt()
    `);
    let connects = 0;
    const delayedPool = new Proxy(fixture.pool, { get(target, property, receiver) {
      if (property === 'connect') return async () => {
        connects++;
        if (connects === 3) await claimGate;
        return target.connect();
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    let claimedAfterAbort = false;
    const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate(input) {
      if (input.context.currentSituation === '지연된 다음 claim') {
        claimedAfterAbort = input.signal?.aborted === true;
        throw new AiProviderError('AI_CANCELLED', true);
      }
      return { result: grounded(input.context), usage: null };
    } };
    const running = runWorker({ pool: delayedPool, provider, signal: caller.signal, concurrency: 2, pollIntervalMs: 5 });
    const beforeRelease = await Promise.race([running.then(() => 'resolved', () => 'rejected'), new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 100))]);
    assert.equal(beforeRelease, 'pending');
    releaseClaim();
    assert.equal(await running.then(() => 'resolved', () => 'rejected'), 'rejected');
    assert.equal(claimedAfterAbort, true);
    const secondDetail = await fixture.app.inject({ url: `/v1/readings/${second.json().readingId}`, headers: secondHeaders });
    assert.equal(secondDetail.json().status, 'FAILED');
  } finally {
    releaseClaim();
    caller.abort();
    await new Promise(resolve => setTimeout(resolve, 20));
    await fixture.close();
  }
});

test('worker preserves undefined as a real loop rejection reason', async () => {
  const pool = { connect: async () => Promise.reject(undefined) } as unknown as Parameters<typeof runWorker>[0]['pool'];
  const provider: ReadingProvider = { name: 'fixture', model: 'fixture-v1', aiGenerated: false, async generate() { throw new Error('must not generate'); } };
  const outcome = await runWorker({ pool, provider, signal: new AbortController().signal })
    .then(() => ({ rejected: false, reason: 'resolved' }), reason => ({ rejected: true, reason }));
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.reason, undefined);
});
