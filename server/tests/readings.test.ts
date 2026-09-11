import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readingFixture } from './helpers.ts';

test('accepts a reading once and exposes only frozen public input', async () => {
  const f = await readingFixture();
  try {
    const key = randomUUID();
    const accepted = await f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': key }, payload: f.body });
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal(accepted.json().attemptNo, 1);
    assert.equal(accepted.json().status, 'QUEUED');
    const detail = (await f.app.inject({ url: accepted.json().statusUrl, headers: f.headers })).json();
    assert.equal(detail.input.personNickname, '민지');
    assert.equal(detail.input.cards.length, 3);
    assert.equal(detail.result, null);
    assert.equal(detail.aiGenerated, false);
    assert.equal(detail.testContent, true);
    assert.equal('candidates' in detail.input.cards[0], false);
    assert.equal('snapshot' in detail, false);
    const replay = await f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': key.toUpperCase() }, payload: { ...f.body, personId: f.body.personId.toUpperCase(), selections: [...f.body.selections].reverse() } });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().readingId, detail.id);
  } finally { await f.close(); }
});

test('simultaneous normalized requests create one reading and active requests are bounded', async () => {
  const f = await readingFixture();
  try {
    const key = randomUUID();
    const send = (body = f.body, idempotencyKey = key) => f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': idempotencyKey }, payload: body });
    const responses = await Promise.all([send(), send()]);
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 202]);
    assert.equal(responses[0].json().readingId, responses[1].json().readingId);
    assert.equal((await f.pool.query('SELECT * FROM readings')).rowCount, 1);
    assert.equal((await f.pool.query('SELECT * FROM reading_attempts')).rowCount, 1);
    const conflict = await send({ ...f.body, personVersion: 999 });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
    const limited = await send(f.body, randomUUID());
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.equal(typeof limited.json().error.requestId, 'string');
    assert.equal(typeof limited.json().error.retryable, 'boolean');
  } finally { await f.close(); }
});

test('rejects malformed, stale, missing, and foreign reading inputs without creating work', async () => {
  const f = await readingFixture();
  try {
    const send = (body: object, headers = f.headers, url = '/v1/readings') => f.app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: body });
    const invalid = [
      { ...f.body, userId: randomUUID() },
      { ...f.body, selections: f.body.selections.slice(1) },
      { ...f.body, selections: f.body.selections.map((s: object) => ({ ...s, positionIndex: 1 })) },
      { ...f.body, selections: f.body.selections.map((s: object) => ({ ...s, cardId: f.body.selections[0].cardId })) },
      { ...f.body, question: { ...f.body.question, customText: 'forbidden' } },
      { ...f.body, question: { ...f.body.question, unexpected: true } },
    ];
    for (const body of invalid) assert.equal((await send(body)).statusCode, 400);
    assert.equal((await send(f.body, f.headers, '/v1/readings?extra=1')).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/readings', headers: f.headers, payload: f.body })).statusCode, 400);
    assert.equal((await send(f.body, {} as typeof f.headers)).statusCode, 401);
    for (const body of [{ ...f.body, personVersion: 999 }, { ...f.body, question: { ...f.body.question, version: 999 } }]) {
      const stale = await send(body);
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error.code, 'STALE_VERSION');
    }
    assert.equal((await send({ ...f.body, personId: randomUUID() })).statusCode, 404);
    const bob = (await f.app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey: randomUUID() } })).json();
    assert.equal((await send(f.body, { authorization: `Bearer ${bob.token}` })).statusCode, 404);
  } finally { await f.close(); }
});

test('custom templates work across relationships and normalize Unicode custom text', async () => {
  const f = await readingFixture();
  try {
    const catalog = (await f.app.inject({ url: '/v1/questions?relationshipCode=crush', headers: f.headers })).json().items;
    const custom = catalog.find((q: { isCustomTemplate: boolean }) => q.isCustomTemplate);
    assert.ok(custom, 'custom template must accompany recommended questions');
    const send = (customText?: string, key = randomUUID()) => f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': key }, payload: { ...f.body, question: { id: custom.id, version: custom.version, ...(customText === undefined ? {} : { customText }) } } });
    for (const text of [undefined, '   ', '😀'.repeat(501)]) assert.equal((await send(text)).statusCode, 400);
    const key = randomUUID();
    const accepted = await send(`  ${'😀'.repeat(500)}  `, key);
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal((await send('😀'.repeat(500), key)).statusCode, 200);
    const detail = (await f.app.inject({ url: accepted.json().statusUrl, headers: f.headers })).json();
    assert.equal(detail.input.question.isCustom, true);
    assert.equal(Array.from(detail.input.question.text).length, 500);
  } finally { await f.close(); }
});

test('snapshots preserve active independent sources and replay before current version checks', async () => {
  const f = await readingFixture();
  try {
    const key = randomUUID();
    const send = () => f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': key }, payload: f.body });
    const accepted = await send(); assert.equal(accepted.statusCode, 202);
    const readingId = accepted.json().readingId;
    const original = (await f.pool.query('SELECT request_snapshot FROM readings WHERE id = $1', [readingId])).rows[0].request_snapshot;
    assert.equal(original.cards[0].candidates.length, 3);
    assert.deepEqual(original.cards[0].candidates.map((c: { version: number }) => c.version).sort(), [1, 1, 3]);
    await f.app.inject({ method: 'PATCH', url: `/v1/persons/${f.person.id}`, headers: f.headers, payload: { version: 1, nickname: '바뀐 이름' } });
    await f.pool.query('UPDATE questions SET prompt = $1 WHERE id = $2', ['새 질문', f.body.question.id]);
    await f.pool.query('UPDATE interpretations SET active_version = 1');
    await f.pool.query('UPDATE tarot_cards SET name = $1', ['새 이름']);
    assert.equal((await send()).statusCode, 200);
    assert.deepEqual((await f.pool.query('SELECT request_snapshot FROM readings WHERE id = $1', [readingId])).rows[0].request_snapshot, original);
    const { seedDevelopment } = await import('../src/db/seed.ts');
    await seedDevelopment(f.pool);
    assert.ok((await f.pool.query('SELECT active_version FROM interpretations')).rows.every(row => row.active_version === 1));
    const before = (await f.pool.query('SELECT version FROM questions WHERE id = $1', [f.body.question.id])).rows[0].version;
    await f.pool.query('UPDATE card_positions SET description = $1 WHERE question_id = $2 AND position = 1', ['변경 설명', f.body.question.id]);
    assert.equal((await f.pool.query('SELECT version FROM questions WHERE id = $1', [f.body.question.id])).rows[0].version, before + 1);
    await assert.rejects(() => f.pool.query('UPDATE interpretations SET active_version = 999'), (e: { code?: string }) => e.code === '23503');
    await assert.rejects(() => f.pool.query('UPDATE reading_evidence SET version = 999'), (e: { code?: string }) => e.code === '23503');
    const otherUser = randomUUID();
    await f.pool.query('INSERT INTO users (id, subject_hash) VALUES ($1, $2)', [otherUser, 'b'.repeat(64)]);
    await assert.rejects(() => f.pool.query('UPDATE readings SET user_id = $1 WHERE id = $2', [otherUser, readingId]), (e: { code?: string }) => e.code === '23503');
  } finally { await f.close(); }
});

test('unavailable content and bounded context reject instead of truncating candidates', async () => {
  const f = await readingFixture();
  try {
    const send = () => f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: f.body });
    // Removing source availability must hide the card and reject its submission.
    await f.pool.query('UPDATE interpretations SET is_active = false WHERE tarot_card_id = $1', [f.body.selections[0].cardId]);
    let response = await send(); assert.equal(response.statusCode, 422); assert.equal(response.json().error.code, 'CONTENT_UNAVAILABLE');
    assert.equal((await f.app.inject({ url: '/v1/cards', headers: f.headers })).json().items.length, 2);
    await f.pool.query('UPDATE interpretations SET is_active = true');
    // New source versions carry large context; existing versions remain immutable.
    await f.pool.query("INSERT INTO interpretation_versions(id, interpretation_id, version, content, source_kind, source_attribution) SELECT gen_random_uuid(), id, 10, $1, 'synthetic_test', 'test' FROM interpretations", ['x'.repeat(25000)]);
    await f.pool.query('UPDATE interpretations SET active_version = 10');
    response = await send(); assert.equal(response.statusCode, 422); assert.equal(response.json().error.code, 'CONTENT_CONTEXT_LIMIT');
    await f.pool.query('UPDATE interpretations SET active_version = 1');
    for (let index = 0; index < 18; index++) {
      const id = randomUUID();
      await f.pool.query('INSERT INTO interpretations(id, tarot_card_id) VALUES ($1, $2)', [id, f.body.selections[0].cardId]);
      await f.pool.query("INSERT INTO interpretation_versions(id, interpretation_id, version, content, source_kind, source_attribution) VALUES ($1,$2,1,'extra','synthetic_test','test')", [randomUUID(), id]);
      await f.pool.query('UPDATE interpretations SET active_version = 1 WHERE id = $1', [id]);
    }
    response = await send(); assert.equal(response.statusCode, 422); assert.equal(response.json().error.code, 'CONTENT_CONTEXT_LIMIT');
  } finally { await f.close(); }
});


test('production rejects synthetic sources and content activation/version changes are enforced', async () => {
  const f = await readingFixture();
  try {
    const { createReading } = await import('../src/readings/store.ts');
    const userId = (await f.pool.query('SELECT user_id FROM persons WHERE id = $1', [f.person.id])).rows[0].user_id;
    await assert.rejects(() => createReading(f.pool, userId, randomUUID(), f.body as never, true), (e: { code?: string }) => e.code === 'CONTENT_UNAVAILABLE');
    const send = (body = f.body) => f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: body });
    const initial = f.body.question.version;
    await f.pool.query('UPDATE questions SET prompt = $1 WHERE id = $2', ['changed prompt', f.body.question.id]);
    assert.equal((await send()).json().error.code, 'STALE_VERSION');
    assert.equal((await f.pool.query('SELECT version FROM questions WHERE id = $1', [f.body.question.id])).rows[0].version, initial + 1);
    await f.pool.query('UPDATE questions SET is_active = false WHERE id = $1', [f.body.question.id]);
    assert.equal((await send({ ...f.body, question: { ...f.body.question, version: initial + 2 } })).json().error.code, 'CONTENT_UNAVAILABLE');
    await f.pool.query('UPDATE questions SET is_active = true WHERE id = $1', [f.body.question.id]);
    await f.pool.query('DELETE FROM card_positions WHERE question_id = $1 AND position = 3', [f.body.question.id]);
    const version = (await f.pool.query('SELECT version FROM questions WHERE id = $1', [f.body.question.id])).rows[0].version;
    assert.equal(version, initial + 4);
    assert.equal((await send({ ...f.body, question: { ...f.body.question, version } })).json().error.code, 'CONTENT_UNAVAILABLE');
    await assert.rejects(() => f.pool.query('UPDATE interpretation_versions SET content = $1', ['overwritten']), /immutable/);
    assert.equal((await f.pool.query('SELECT * FROM readings')).rowCount, 0);
  } finally { await f.close(); }
});

test('database protects active work and card uniqueness independently of HTTP serialization', async () => {
  const f = await readingFixture();
  try {
    const accepted = await f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: f.body });
    assert.equal(accepted.statusCode, 202);
    const readingId = accepted.json().readingId;
    await assert.rejects(() => f.pool.query("INSERT INTO reading_attempts(id,reading_id,attempt_no,status) VALUES ($1,$2,2,'QUEUED')", [randomUUID(), readingId]), (e: { code?: string }) => e.code === '23505');
    await assert.rejects(() => f.pool.query("INSERT INTO readings(id,user_id,person_id,status,current_attempt_no,request_snapshot,contract_version,prompt_version) SELECT $1,user_id,person_id,'QUEUED',1,request_snapshot,contract_version,prompt_version FROM readings WHERE id=$2", [randomUUID(), readingId]), (e: { code?: string }) => e.code === '23505');
    await assert.rejects(() => f.pool.query('UPDATE reading_cards SET position_index = 1 WHERE reading_id = $1', [readingId]), (e: { code?: string }) => e.code === '23505');
    await assert.rejects(() => f.pool.query('UPDATE reading_cards SET card_id = $1 WHERE reading_id = $2', [f.body.selections[0].cardId, readingId]), (e: { code?: string }) => e.code === '23505');
    const bob = (await f.app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey: randomUUID() } })).json();
    const foreignHeaders = { authorization: `Bearer ${bob.token}` };
    for (const url of [accepted.json().statusUrl, `/v1/persons/${f.person.id}/readings`]) assert.equal((await f.app.inject({ url, headers: foreignHeaders })).statusCode, 404);
    const retry = (payload: object, headers = f.headers, suffix = '') => f.app.inject({ method: 'POST', url: `${accepted.json().statusUrl}/retry${suffix}`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload });
    assert.equal((await retry({ expectedAttemptNo: 1 }, foreignHeaders)).statusCode, 404);
    assert.equal((await retry({ expectedAttemptNo: 1, unexpected: true })).statusCode, 400);
    assert.equal((await retry({ expectedAttemptNo: 1 }, f.headers, '?extra=1')).statusCode, 400);
    assert.equal((await retry({ expectedAttemptNo: 1 })).statusCode, 409);
    assert.equal((await f.app.inject({ url: '/v1/readings/not-uuid', headers: f.headers })).statusCode, 400);
    const preflight = await f.app.inject({ method: 'OPTIONS', url: '/v1/readings', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'Idempotency-Key' } });
    assert.match(String(preflight.headers['access-control-allow-headers']), /Idempotency-Key/i);
  } finally { await f.close(); }
});


test('whitespace-only active sources never make a card readable', async () => {
  const f = await readingFixture();
  try {
    await f.pool.query("INSERT INTO interpretation_versions(id, interpretation_id, version, content, source_kind, source_attribution) SELECT gen_random_uuid(), id, 10, $1, 'synthetic_test', 'test' FROM interpretations", ['\n\t　']);
    await f.pool.query('UPDATE interpretations SET active_version = 10');
    const cards = await f.app.inject({ url: '/v1/cards', headers: f.headers });
    assert.equal(cards.json().items.length, 0);
    const response = await f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: f.body });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'CONTENT_UNAVAILABLE');
  } finally { await f.close(); }
});


test('active-reading limits do not replace missing-resource and stale-version responses', async () => {
  const f = await readingFixture();
  try {
    const send = (body = f.body) => f.app.inject({ method: 'POST', url: '/v1/readings', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: body });
    assert.equal((await send()).statusCode, 202);
    assert.equal((await send({ ...f.body, personId: randomUUID() })).statusCode, 404);
    assert.equal((await send({ ...f.body, personVersion: 999 })).json().error.code, 'STALE_VERSION');
  } finally { await f.close(); }
});
