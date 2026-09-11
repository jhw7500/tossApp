import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { readingFixture } from './helpers.ts';
import type { ReadingClaim, ReadingResult } from '../src/readings/types.ts';

function resultFor(claim: ReadingClaim): ReadingResult {
  return {
    cards: claim.snapshot.cards.map(card => ({ cardId: card.cardId, positionIndex: card.positionIndex, text: '시험 원문을 조합한 설명', evidence: [{ interpretationId: card.candidates[0].interpretationId, version: card.candidates[0].version }] })),
    overallReading: '세 카드의 시험용 종합 설명', summary: '시험용 요약',
  };
}

async function acceptedFixture() {
  const f = await readingFixture();
  const key = randomUUID();
  const response = await f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': key }, payload: f.body });
  if (response.statusCode !== 202) { await f.close(); assert.equal(response.statusCode, 202, response.body); }
  return { ...f, key, readingId: response.json().readingId as string, statusUrl: response.json().statusUrl as string };
}

test('concurrent workers claim once and atomically persist success, evidence, and Person aggregates', async () => {
  const f = await acceptedFixture();
  try {
    const { claimNextReading, completeReading } = await import('../src/readings/attempts.ts');
    const claims = await Promise.all([claimNextReading(f.pool, { provider: 'test', model: 'fixture' }), claimNextReading(f.pool, { provider: 'test', model: 'fixture' })]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean)!;
    assert.equal(claim.promptVersion, 'tarot-grounded.v1');
    assert.equal(claim.contractVersion, 'reading-result.v1');
    assert.equal(await completeReading(f.pool, claim, { result: resultFor(claim), usage: { inputTokens: 10, outputTokens: 20 }, aiGenerated: true }), true);
    assert.equal(await completeReading(f.pool, claim, { result: resultFor(claim), usage: null, aiGenerated: true }), false);
    const detail = (await f.app.inject({ url: f.statusUrl, headers: f.headers })).json();
    assert.equal(detail.status, 'SUCCEEDED'); assert.equal(detail.result.summary, '시험용 요약'); assert.equal(detail.aiGenerated, true);
    assert.equal((await f.pool.query('SELECT * FROM reading_evidence WHERE selected')).rowCount, 3);
    const person = (await f.app.inject({ url: `/v1/persons/${f.person.id}`, headers: f.headers })).json();
    assert.equal(person.readingCount, 1); assert.ok(person.lastReadingAt);
    const updated = (await f.app.inject({ method: 'PATCH', url: `/v1/persons/${f.person.id}`, headers: f.headers, payload: { version: 1, nickname: 'new' } })).json();
    assert.equal(updated.readingCount, 1); assert.equal(updated.lastReadingAt, person.lastReadingAt);
    const reconnect = new Pool(f.pool.options);
    try { assert.equal((await reconnect.query('SELECT status FROM readings WHERE id = $1', [f.readingId])).rows[0].status, 'SUCCEEDED'); } finally { await reconnect.end(); }
    const retry = await f.app.inject({ method: 'POST', url: `${f.statusUrl}/retry`, headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { expectedAttemptNo: 1 } });
    assert.equal(retry.statusCode, 409);
  } finally { await f.close(); }
});

test('invalid cross-card evidence never partially saves success', async () => {
  const f = await acceptedFixture();
  try {
    const { claimNextReading, completeReading } = await import('../src/readings/attempts.ts');
    const claim = (await claimNextReading(f.pool, { provider: 'test', model: 'fixture' }))!;
    const result = resultFor(claim);
    result.cards[0].evidence = result.cards[1].evidence;
    await assert.rejects(() => completeReading(f.pool, claim, { result, usage: null, aiGenerated: true }), /evidence|output/i);
    assert.equal((await f.pool.query('SELECT * FROM reading_evidence WHERE selected')).rowCount, 0);
    assert.equal((await f.pool.query('SELECT status FROM readings')).rows[0].status, 'RUNNING');
  } finally { await f.close(); }
});

test('expired queue and lease fail durably, explicit retries stop at three, old keys retain their attempts', async () => {
  const f = await acceptedFixture();
  try {
    const { claimNextReading, completeReading, failReading, expireReadings } = await import('../src/readings/attempts.ts');
    await f.pool.query("UPDATE reading_attempts SET queued_at = clock_timestamp() - interval '61 seconds' WHERE reading_id = $1", [f.readingId]);
    const timedOut = (await f.app.inject({ url: f.statusUrl, headers: f.headers })).json();
    assert.equal(timedOut.status, 'FAILED'); assert.equal(timedOut.error.code, 'QUEUE_TIMEOUT');
    const retry = (key: string, expectedAttemptNo: number) => f.app.inject({ method: 'POST', url: `${f.statusUrl}/retry`, headers: { ...f.headers, 'idempotency-key': key }, payload: { expectedAttemptNo } });
    const key = randomUUID();
    const retries = await Promise.all([retry(key, 1), retry(key, 1)]);
    assert.deepEqual(retries.map(r => r.statusCode).sort(), [200, 202]);
    const oldReplay = await f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': f.key }, payload: f.body });
    assert.equal(oldReplay.statusCode, 200); assert.equal(oldReplay.json().attemptNo, 1); assert.equal(oldReplay.json().status, 'FAILED');
    const oldClaim = (await claimNextReading(f.pool, { provider: 'test', model: 'fixture' }))!;
    assert.equal(oldClaim.attemptNo, 2);
    await f.pool.query("UPDATE reading_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [oldClaim.attemptId]);
    assert.equal(await completeReading(f.pool, oldClaim, { result: resultFor(oldClaim), usage: null, aiGenerated: true }), false);
    assert.equal(await expireReadings(f.pool), 1);
    assert.equal((await f.app.inject({ url: f.statusUrl, headers: f.headers })).json().error.code, 'WORKER_TIMEOUT');
    assert.equal((await retry(randomUUID(), 2)).statusCode, 202);
    const third = (await claimNextReading(f.pool, { provider: 'test', model: 'fixture' }))!;
    assert.equal(third.attemptNo, 3);
    assert.equal(await failReading(f.pool, oldClaim, { code: 'AI_UNAVAILABLE', message: 'old failure', retryable: true }), false);
    assert.equal(await completeReading(f.pool, oldClaim, { result: resultFor(oldClaim), usage: null, aiGenerated: true }), false);
    assert.equal(await failReading(f.pool, third, { code: 'AI_UNAVAILABLE', message: 'temporary error', retryable: true }), true);
    assert.equal((await retry(randomUUID(), 3)).statusCode, 409);
    assert.equal((await f.app.inject({ url: `/v1/persons/${f.person.id}`, headers: f.headers })).json().readingCount, 0);
  } finally { await f.close(); }
});

test('nonretryable failure refuses a new attempt and history preserves microsecond cursor order', async () => {
  const f = await acceptedFixture();
  try {
    const { claimNextReading, failReading } = await import('../src/readings/attempts.ts');
    const first = (await claimNextReading(f.pool, { provider: 'test', model: 'fixture' }))!;
    await failReading(f.pool, first, { code: 'AI_REFUSED', message: 'unavailable', retryable: false });
    const retry = await f.app.inject({ method: 'POST', url: `${f.statusUrl}/retry`, headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { expectedAttemptNo: 1 } });
    assert.equal(retry.statusCode, 409); assert.equal(retry.json().error.code, 'RETRY_NOT_ALLOWED');
    const second = await f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: f.body });
    assert.equal(second.statusCode, 202);
    await f.pool.query('UPDATE readings SET created_at = $1 WHERE id = $2', ['2026-09-11T00:00:00.123001Z', f.readingId]);
    await f.pool.query('UPDATE readings SET created_at = $1 WHERE id = $2', ['2026-09-11T00:00:00.123999Z', second.json().readingId]);
    const url = `/v1/persons/${f.person.id}/readings?limit=1`;
    const page = (await f.app.inject({ url, headers: f.headers })).json();
    assert.equal(page.items[0].id, second.json().readingId); assert.ok(page.nextCursor);
    assert.match(Buffer.from(page.nextCursor, 'base64url').toString(), /123999Z/);
    const next = (await f.app.inject({ url: `${url}&cursor=${page.nextCursor}`, headers: f.headers })).json();
    assert.equal(next.items[0].id, f.readingId); assert.equal(next.nextCursor, null);
    assert.equal((await f.app.inject({ url: `${url}&cursor=bad`, headers: f.headers })).statusCode, 400);
    assert.equal((await f.app.inject({ url: `${url}&extra=1`, headers: f.headers })).statusCode, 400);
    assert.equal((await f.app.inject({ url: f.statusUrl })).statusCode, 401);
    assert.equal((await f.app.inject({ url: `/v1/readings/${randomUUID()}`, headers: f.headers })).statusCode, 404);
  } finally { await f.close(); }
});


test('completion rejects malformed results and missing durable evidence while preserving RUNNING state', async () => {
  const f = await acceptedFixture();
  try {
    const { claimNextReading, completeReading } = await import('../src/readings/attempts.ts');
    const claim = (await claimNextReading(f.pool, { provider: 'test', model: 'fixture' }))!;
    const valid = resultFor(claim);
    const invalid = [
      { ...valid, summary: ' ' },
      { ...valid, extra: true },
      { ...valid, cards: valid.cards.slice(1) },
      { ...valid, cards: [valid.cards[0], valid.cards[0], valid.cards[2]] },
      { ...valid, cards: valid.cards.map((card, index) => index === 0 ? { ...card, evidence: [...card.evidence, ...card.evidence] } : card) },
      { ...valid, cards: valid.cards.map((card, index) => index === 0 ? { ...card, text: '😀'.repeat(801) } : card) },
    ];
    for (const result of invalid) await assert.rejects(() => completeReading(f.pool, claim, { result, usage: null, aiGenerated: true }), /output/i);
    const evidence = valid.cards[0].evidence[0];
    await f.pool.query('DELETE FROM reading_evidence WHERE interpretation_id = $1 AND version = $2', [evidence.interpretationId, evidence.version]);
    await assert.rejects(() => completeReading(f.pool, claim, { result: valid, usage: null, aiGenerated: true }), /stored candidate/);
    assert.equal((await f.pool.query('SELECT * FROM reading_evidence WHERE selected')).rowCount, 0);
    assert.equal((await f.pool.query('SELECT status FROM reading_attempts')).rows[0].status, 'RUNNING');
  } finally { await f.close(); }
});

test('retry expires its target without worker help and rejects stale expected attempt numbers', async () => {
  const f = await acceptedFixture();
  try {
    await f.pool.query("UPDATE reading_attempts SET queued_at = clock_timestamp() - interval '61 seconds' WHERE reading_id = $1", [f.readingId]);
    const retry = (number: number) => f.app.inject({ method: 'POST', url: `${f.statusUrl}/retry`, headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { expectedAttemptNo: number } });
    const stale = await retry(2);
    assert.equal(stale.statusCode, 409);
    assert.equal((await f.pool.query('SELECT status FROM readings')).rows[0].status, 'FAILED');
    assert.equal((await retry(1)).statusCode, 202);
    assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM reading_attempts')).rows[0].n, 2);
  } finally { await f.close(); }
});


test('worker skips a locked reading and can claim another user without waiting for the lock', async () => {
  const f = await acceptedFixture();
  const blocker = await f.pool.connect();
  try {
    const { claimNextReading } = await import('../src/readings/attempts.ts');
    const bob = (await f.app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey: randomUUID() } })).json();
    const headers = { authorization: `Bearer ${bob.token}` };
    const person = (await f.app.inject({ method: 'POST', url: '/v1/persons', headers, payload: { nickname: 'bob person', relationshipCode: 'crush' } })).json();
    const other = await f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { ...f.body, personId: person.id } });
    assert.equal(other.statusCode, 202);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM readings WHERE id = $1 FOR UPDATE', [f.readingId]);
    // A bounded connection timeout makes accidentally waiting on the first job fail the test.
    const workerPool = new Pool({ ...f.pool.options, statement_timeout: 1000 });
    try {
      const claim = await claimNextReading(workerPool, { provider: 'test', model: 'fixture' });
      assert.equal(claim?.readingId, other.json().readingId);
    } finally { await workerPool.end(); }
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await f.close(); }
});

test('a retry key reused for another eligible reading conflicts without creating an attempt', async () => {
  const f = await acceptedFixture();
  try {
    const { claimNextReading, failReading } = await import('../src/readings/attempts.ts');
    const failCurrent = async () => {
      const claim = await claimNextReading(f.pool, { provider: 'test', model: 'fixture' });
      assert.ok(claim);
      assert.equal(await failReading(f.pool, claim, {
        code: 'AI_UNAVAILABLE', message: 'temporary error', retryable: true,
      }), true);
    };
    await failCurrent();
    const second = await f.app.inject({
      method: 'POST', url: '/v1/readings',
      headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: f.body,
    });
    assert.equal(second.statusCode, 202);
    const secondReadingId = second.json().readingId as string;
    await failCurrent();

    const key = randomUUID();
    const retry = (readingId: string) => f.app.inject({
      method: 'POST', url: `/v1/readings/${readingId}/retry`,
      headers: { ...f.headers, 'idempotency-key': key }, payload: { expectedAttemptNo: 1 },
    });
    assert.equal((await retry(f.readingId)).statusCode, 202);
    const replay = await retry(f.readingId.toUpperCase());
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().readingId, f.readingId);
    assert.equal(replay.json().attemptNo, 2);
    await failCurrent();

    const conflict = await retry(secondReadingId);
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await f.pool.query(
      'SELECT count(*)::integer AS count FROM reading_attempts WHERE reading_id = $1',
      [secondReadingId],
    )).rows[0].count, 1);
    const unchanged = (await f.pool.query(
      'SELECT status, current_attempt_no FROM readings WHERE id = $1', [secondReadingId],
    )).rows[0];
    assert.deepEqual(unchanged, { status: 'FAILED', current_attempt_no: 1 });
  } finally { await f.close(); }
});
