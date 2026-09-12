// Run through `docker exec -i tarororo-test-worker-1 node --input-type=module`.
// Uses an in-process authentication fixture, never an HTTP listener.
// Calls the real Gemini worker once; this does NOT verify Toss mTLS or phone access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '/app/server/src/app.ts';
import { createPool } from '/app/server/src/db/pool.ts';

const password = (await readFile('/run/secrets/db-password', 'utf8')).trim();
const pool = createPool(`postgresql://tarororo:${encodeURIComponent(password)}@db:5432/tarororo_test`);
const app = await buildApp({ pool, config: {
  environment: 'test', host: '127.0.0.1', port: 3000, databaseUrl: 'unused',
  authMode: 'mock', subjectSecret: randomUUID().repeat(2),
  allowedOrigins: ['https://tarororo.private-apps.tossmini.com'],
} });

try {
  const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/persons', headers: {
    origin: 'https://tarororo.private-apps.tossmini.com', 'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization,content-type,idempotency-key',
  } });
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://tarororo.private-apps.tossmini.com');
  const denied = await app.inject({ url: '/v1/persons', headers: { origin: 'https://untrusted.example' } });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);

  const session = await app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey: randomUUID() } });
  assert.equal(session.statusCode, 201);
  const headers = { authorization: `Bearer ${session.json().token}` };
  const personResponse = await app.inject({ method: 'POST', url: '/v1/persons', headers,
    payload: { nickname: '배포 검증', relationshipCode: 'crush', currentSituation: '샘플 관계로 배포 연결만 확인합니다.' } });
  assert.equal(personResponse.statusCode, 201);
  const person = personResponse.json();
  const questions = (await app.inject({ url: '/v1/questions?relationshipCode=crush', headers })).json().items;
  const question = questions.find(item => !item.isCustomTemplate);
  const cards = (await app.inject({ url: '/v1/cards', headers })).json().items;
  const accepted = await app.inject({ method: 'POST', url: '/v1/readings', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: {
    personId: person.id, personVersion: person.version, question: { id: question.id, version: question.version },
    selections: cards.slice(0, 3).map((card, index) => ({ cardId: card.id, positionIndex: index + 1 })),
  } });
  assert.equal(accepted.statusCode, 202);
  const readingId = accepted.json().readingId;
  let detail;
  for (let attempt = 0; attempt < 45; attempt++) {
    detail = (await app.inject({ url: `/v1/readings/${readingId}`, headers })).json();
    if (['SUCCEEDED', 'FAILED'].includes(detail.status)) break;
    await delay(1000);
  }
  assert.equal(detail.status, 'SUCCEEDED', detail.error?.code ?? 'Worker did not finish');
  assert.equal(detail.aiGenerated, true);
  assert.equal(detail.testContent, true);
  const history = (await app.inject({ url: `/v1/persons/${person.id}/readings`, headers })).json();
  assert.equal(history.items[0].id, readingId);
  console.log(JSON.stringify({ status: 'SUCCEEDED', readingId, testContent: true, aiGenerated: true,
    cors: 'passed', history: 'passed', auth: 'in-process fixture; Toss mTLS unverified' }));
} finally {
  await app.close();
  await pool.end();
}
