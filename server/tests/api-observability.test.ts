import assert from 'node:assert/strict';
import { Agent, get } from 'node:http';
import test from 'node:test';
import type { Pool } from 'pg';

import { buildApp } from '../src/app.ts';
import { HttpError } from '../src/errors.ts';
import type { ApiRequestEvent } from '../src/http/api-observability.ts';
import { createIsolatedPool, testConfig } from './helpers.ts';

function getWithAgent(port: number, agent: Agent): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port, path: '/health/ready', agent }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
  });
}

test('API emits bounded completion metadata for a successful request', async () => {
  const fixture = await createIsolatedPool();
  const events: ApiRequestEvent[] = [];
  const app = await buildApp({
    config: testConfig,
    pool: fixture.pool,
    onEvent(event) { events.push(event); },
  });
  try {
    const response = await app.inject('/health/ready');

    assert.equal(response.statusCode, 200);
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0]).sort(), ['durationMs', 'errorCode', 'event', 'requestId', 'statusCode'].sort());
    assert.equal(events[0].event, 'api_request_finished');
    assert.equal(typeof events[0].requestId, 'string');
    assert.equal(events[0].statusCode, 200);
    assert.equal(events[0].errorCode, null);
    assert.equal(Number.isFinite(events[0].durationMs) && Number(events[0].durationMs) >= 0, true);
  } finally {
    await app.close();
    await fixture.dispose();
  }
});

test('readiness failure keeps its response and emits a bounded error code', async () => {
  const pool = { query: async () => { throw new Error('private database readiness detail'); } } as unknown as Pool;
  const events: ApiRequestEvent[] = [];
  const app = await buildApp({
    config: testConfig,
    pool,
    onEvent(event) { events.push(event); },
  });
  try {
    const response = await app.inject('/health/ready');

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: 'unavailable' });
    assert.equal(events.length, 1);
    assert.equal(events[0].errorCode, 'SERVICE_UNAVAILABLE');
    assert.equal(JSON.stringify(events).includes('private database readiness detail'), false);
  } finally {
    await app.close();
  }
});

test('API events report normalized error codes without request or error content', async () => {
  const fixture = await createIsolatedPool();
  const events: ApiRequestEvent[] = [];
  const app = await buildApp({
    config: testConfig,
    pool: fixture.pool,
    verifyAnonymousKey: async () => true,
    onEvent(event) { events.push(event); },
  });
  app.get('/test/internal-error', async () => { throw new Error('private database detail'); });
  app.get('/test/malformed-code', async () => { throw new HttpError(418, 'private account-42', 'private response detail'); });
  try {
    const anonymousKey = 'private-anonymous-key';
    const session = await app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey } });
    const token = session.json().token as string;
    const auth = { authorization: `Bearer ${token}` };
    events.length = 0;

    assert.equal((await app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey, privateBodyField: 'private body value' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/persons', headers: { authorization: 'Bearer private-invalid-token' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/missing/private-path', headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/test/internal-error', headers: auth })).statusCode, 500);
    assert.equal((await app.inject({ method: 'GET', url: '/test/malformed-code', headers: auth })).statusCode, 418);

    assert.deepEqual(events.map(event => event.statusCode), [400, 401, 404, 500, 418]);
    assert.deepEqual(events.map(event => event.errorCode), ['INVALID_INPUT', 'UNAUTHORIZED', 'NOT_FOUND', 'INTERNAL_ERROR', 'INTERNAL_ERROR']);
    for (const event of events) {
      assert.deepEqual(Object.keys(event).sort(), ['durationMs', 'errorCode', 'event', 'requestId', 'statusCode'].sort());
    }
    const serialized = JSON.stringify(events);
    for (const privateValue of [anonymousKey, token, 'private body value', 'private-invalid-token', 'private-path', 'private database detail', 'private account-42', 'private response detail']) {
      assert.equal(serialized.includes(privateValue), false);
    }
  } finally {
    await app.close();
    await fixture.dispose();
  }
});

test('API observer failures never change HTTP responses', async () => {
  const fixture = await createIsolatedPool();
  const syncApp = await buildApp({
    config: testConfig,
    pool: fixture.pool,
    onEvent() { throw new Error('sync logger unavailable'); },
  });
  const asyncApp = await buildApp({
    config: testConfig,
    pool: fixture.pool,
    async onEvent() { throw new Error('async logger unavailable'); },
  });
  try {
    const syncResponse = await syncApp.inject('/health/ready');
    const asyncResponse = await asyncApp.inject('/health/ready');

    assert.equal(syncResponse.statusCode, 200);
    assert.deepEqual(syncResponse.json(), { status: 'ready' });
    assert.equal(asyncResponse.statusCode, 200);
    assert.deepEqual(asyncResponse.json(), { status: 'ready' });
  } finally {
    await syncApp.close();
    await asyncApp.close();
    await fixture.dispose();
  }
});

test('API disables Fastify request logs that can contain URLs and client metadata', async () => {
  const fixture = await createIsolatedPool();
  const events: ApiRequestEvent[] = [];
  type BuildAppOptions = Parameters<typeof buildApp>[0];
  type FastifyLoggerIsUnavailable = 'logger' extends keyof BuildAppOptions ? false : true;
  const fastifyLoggerIsUnavailable: FastifyLoggerIsUnavailable = true;
  const app = await buildApp({
    config: testConfig,
    pool: fixture.pool,
    onEvent(event) { events.push(event); },
  });
  app.get('/test/duplicate-send', async (_request, reply) => {
    reply.send({ status: 'first response' });
    return reply.send({ status: 'duplicate response' });
  });
  try {
    const session = await app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey: 'log-test-key' } });
    const auth = { authorization: `Bearer ${session.json().token as string}` };
    events.length = 0;
    const privateQuery = 'private-query-value';
    const response = await app.inject({ method: 'GET', url: `/test/duplicate-send?secret=${privateQuery}`, headers: auth });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'first response' });
    assert.equal(fastifyLoggerIsUnavailable, true);
    assert.equal(events.length, 1);
    assert.equal(JSON.stringify(events).includes(privateQuery), false);
  } finally {
    await app.close();
    await fixture.dispose();
  }
});

test('requests accepted during graceful shutdown still emit exactly one completion event', async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 1 }) } as unknown as Pool;
  const events: ApiRequestEvent[] = [];
  const app = await buildApp({ config: testConfig, pool, onEvent(event) { events.push(event); } });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let releasePreClose!: () => void;
  let signalPreClose!: () => void;
  const preCloseGate = new Promise<void>(resolve => { releasePreClose = resolve; });
  const preCloseStarted = new Promise<void>(resolve => { signalPreClose = resolve; });
  app.addHook('preClose', async () => {
    signalPreClose();
    await preCloseGate;
  });
  let closing: Promise<void> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const first = await getWithAgent(address.port, agent);
    assert.equal(first.statusCode, 200);

    closing = app.close();
    await preCloseStarted;
    const duringShutdown = await getWithAgent(address.port, agent);
    releasePreClose();
    await closing;

    assert.equal(duringShutdown.statusCode, 200);
    assert.deepEqual(JSON.parse(duringShutdown.body), { status: 'ready' });
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.statusCode), [200, 200]);
  } finally {
    releasePreClose();
    agent.destroy();
    await closing?.catch(() => undefined);
    await app.close().catch(() => undefined);
  }
});
