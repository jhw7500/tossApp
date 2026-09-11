import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildApp } from '../src/app.ts';
import { createIsolatedPool, testConfig } from './helpers.ts';

async function makeSession(app: Awaited<ReturnType<typeof buildApp>>, anonymousKey: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey } });
  assert.equal(response.statusCode, 201);
  return response.json().token as string;
}

test('Person API enforces ownership, versions, inputs, and cursor pagination', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const app = await buildApp({ config: testConfig, pool, verifyAnonymousKey: async () => true });
  try {
    const aliceToken = await makeSession(app, 'alice-key');
    const bobToken = await makeSession(app, 'bob-key');
    const auth = { authorization: `Bearer ${aliceToken}` };
    const created = await app.inject({ method: 'POST', url: '/v1/persons', headers: auth, payload: { nickname: ' 민지 ', relationshipCode: 'crush' } });
    assert.equal(created.statusCode, 201);
    const person = created.json();
    assert.equal(person.nickname, '민지');
    assert.equal(person.version, 1);
    assert.equal(person.currentSituation, null);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/persons/${person.id}`, headers: { authorization: `Bearer ${bobToken}` } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PATCH', url: `/v1/persons/${person.id}`, headers: { authorization: `Bearer ${bobToken}` }, payload: { version: 1, nickname: 'x' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/persons', headers: auth, payload: { nickname: ' ', relationshipCode: 'crush' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/persons', headers: auth, payload: { nickname: 'M', relationshipCode: 'unknown' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/persons', headers: auth, payload: { nickname: 'M', relationshipCode: 'crush', unexpected: true } })).statusCode, 400);
    const updated = await app.inject({ method: 'PATCH', url: `/v1/persons/${person.id}`, headers: auth, payload: { version: 1, currentSituation: '고민 중' } });
    assert.equal(updated.statusCode, 200); assert.equal(updated.json().version, 2);
    assert.equal((await app.inject({ method: 'PATCH', url: `/v1/persons/${person.id}`, headers: auth, payload: { version: 1, nickname: 'x' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/persons?cursor=bad', headers: auth })).statusCode, 400);
    await app.inject({ method: 'POST', url: '/v1/persons', headers: auth, payload: { nickname: '둘', relationshipCode: 'friendship' } });
    const page = await app.inject({ method: 'GET', url: '/v1/persons?limit=1', headers: auth });
    assert.equal(page.statusCode, 200); assert.equal(page.json().items.length, 1); assert.ok(page.json().nextCursor);
    const secondPage = await app.inject({ method: 'GET', url: `/v1/persons?limit=1&cursor=${page.json().nextCursor}`, headers: auth });
    assert.equal(secondPage.statusCode, 200); assert.equal(secondPage.json().items.length, 1);
  } finally { await app.close(); await dispose(); }
});

test('request parsing rejects malformed JSON, invalid identifiers, unknown query fields, and oversized bodies', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const app = await buildApp({ config: testConfig, pool, verifyAnonymousKey: async () => true });
  try {
    const token = await makeSession(app, 'parse-key'); const auth = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/persons', headers: { ...auth, 'content-type': 'application/json' }, payload: '{"nickname":' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/persons/not-a-uuid', headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/persons?unexpected=value', headers: auth })).statusCode, 400);
    const validCursor = Buffer.from('2026-09-11T00:00:00.123456Z|00000000-0000-4000-8000-000000000001').toString('base64url');
    const badCalendar = Buffer.from('2026-02-30T00:00:00.123456Z|00000000-0000-4000-8000-000000000001').toString('base64url');
    const suffix = Buffer.from('2026-09-11T00:00:00.123456Z|00000000-0000-4000-8000-000000000001|extra').toString('base64url');
    assert.equal((await app.inject({ method: 'GET', url: `/v1/persons?cursor=${validCursor}=`, headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/persons?cursor=${badCalendar}`, headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/persons?cursor=${suffix}`, headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/persons', headers: auth, payload: { nickname: 'large', relationshipCode: 'crush', currentSituation: 'x'.repeat(17 * 1024) } })).statusCode, 413);
  } finally { await app.close(); await dispose(); }
});

test('routes reject unsupported query parameters consistently', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const app = await buildApp({ config: testConfig, pool, verifyAnonymousKey: async () => true });
  try {
    const session = { method: 'POST' as const, url: '/v1/sessions/toss-anonymous?unexpected=value', payload: { anonymousKey: 'query-key' } };
    assert.equal((await app.inject(session)).statusCode, 400);
    const token = await makeSession(app, 'query-key'); const auth = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: 'POST', url: '/v1/persons', headers: auth, payload: { nickname: 'query person', relationshipCode: 'crush' } });
    const personId = created.json().id;
    const cases = [
      { method: 'POST' as const, url: '/v1/persons?unexpected=value', payload: { nickname: 'x', relationshipCode: 'crush' } },
      { method: 'GET' as const, url: `/v1/persons/${personId}?unexpected=value` },
      { method: 'PATCH' as const, url: `/v1/persons/${personId}?unexpected=value`, payload: { version: 1, nickname: 'changed' } },
      { method: 'DELETE' as const, url: '/v1/sessions/current?unexpected=value' },
      { method: 'GET' as const, url: '/health/ready?unexpected=value' },
    ];
    for (const request of cases) assert.equal((await app.inject({ ...request, headers: auth })).statusCode, 400);
  } finally { await app.close(); await dispose(); }
});

test('catalogs, readiness, and revoked sessions use bounded public DTOs', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const app = await buildApp({ config: testConfig, pool, verifyAnonymousKey: async () => true });
  try {
    const token = await makeSession(app, 'catalog-key'); const auth = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
    const relationships = (await app.inject({ method: 'GET', url: '/v1/relationship-types', headers: auth })).json().items;
    assert.ok(relationships.length > 0);
    for (const relationship of relationships) {
      const catalog = await app.inject({ method: 'GET', url: `/v1/questions?relationshipCode=${relationship.code}`, headers: auth });
      assert.equal(catalog.statusCode, 200); assert.ok(catalog.json().items.length > 0); assert.equal(catalog.json().items[0].positions.length, 3);
    }
    const questions = await app.inject({ method: 'GET', url: '/v1/questions?relationshipCode=crush', headers: auth });
    assert.equal(questions.statusCode, 200); assert.equal(questions.json().items[0].positions.length, 3);
    const cards = await app.inject({ method: 'GET', url: '/v1/cards', headers: auth });
    assert.equal(cards.statusCode, 200); assert.equal(cards.json().items.length, 3); assert.equal('interpretations' in cards.json().items[0], false);
    assert.equal((await app.inject({ method: 'DELETE', url: '/v1/sessions/current', headers: auth })).statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/persons', headers: auth })).statusCode, 401);
    const expiredToken = await makeSession(app, 'expired-key');
    await pool.query('UPDATE sessions SET expires_at = now() WHERE token_hash = $1', [createHash('sha256').update(expiredToken).digest('hex')]);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/persons', headers: { authorization: `Bearer ${expiredToken}` } })).statusCode, 401);
  } finally { await app.close(); await dispose(); }
});

test('Toss credential failures are 401 while unavailable verification is 503', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const config = { ...testConfig, authMode: 'toss' as const, tossCertPath: '/tmp/cert', tossKeyPath: '/tmp/key' };
  const invalidApp = await buildApp({ config, pool, verifyAnonymousKey: async () => false });
  const unavailableApp = await buildApp({ config, pool, verifyAnonymousKey: async () => { throw new Error('network down'); } });
  try {
    assert.equal((await invalidApp.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey: 'key' } })).statusCode, 401);
    assert.equal((await unavailableApp.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey: 'key' } })).statusCode, 503);
  } finally { await invalidApp.close(); await unavailableApp.close(); await dispose(); }
});

test('person cursors preserve PostgreSQL microseconds and descending ID ties', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const app = await buildApp({ config: testConfig, pool, verifyAnonymousKey: async () => true });
  try {
    const token = await makeSession(app, 'cursor-key');
    const auth = { authorization: `Bearer ${token}` };
    const create = async (nickname: string): Promise<{ id: string }> => (await app.inject({ method: 'POST', url: '/v1/persons', headers: auth, payload: { nickname, relationshipCode: 'crush' } })).json();
    const tiedA = await create('tie-a'); const tiedB = await create('tie-b');
    await pool.query('UPDATE persons SET created_at = $1 WHERE id = ANY($2::uuid[])', ['2026-09-10T00:00:00.123456Z', [tiedA.id, tiedB.id]]);
    const tiedPageOne = await app.inject({ method: 'GET', url: '/v1/persons?limit=1', headers: auth });
    assert.equal(tiedPageOne.statusCode, 200); assert.equal(tiedPageOne.json().items[0].id, [tiedA.id, tiedB.id].sort().at(-1));
    assert.equal('cursorCreatedAt' in tiedPageOne.json().items[0], false);
    const tiedPageTwo = await app.inject({ method: 'GET', url: `/v1/persons?limit=1&cursor=${tiedPageOne.json().nextCursor}`, headers: auth });
    assert.equal(tiedPageTwo.statusCode, 200); assert.equal(tiedPageTwo.json().items.length, 1);
    const microA = await create('micro-a'); const microB = await create('micro-b');
    await pool.query('UPDATE persons SET created_at = $1 WHERE id = $2', ['2026-09-11T00:00:00.123001Z', microA.id]);
    await pool.query('UPDATE persons SET created_at = $1 WHERE id = $2', ['2026-09-11T00:00:00.123999Z', microB.id]);
    const microPageOne = await app.inject({ method: 'GET', url: '/v1/persons?limit=1', headers: auth });
    assert.equal(microPageOne.json().items[0].id, microB.id);
    const microPageTwo = await app.inject({ method: 'GET', url: `/v1/persons?limit=1&cursor=${microPageOne.json().nextCursor}`, headers: auth });
    assert.equal(microPageTwo.statusCode, 200); assert.equal(microPageTwo.json().items[0].id, microA.id);
  } finally { await app.close(); await dispose(); }
});
