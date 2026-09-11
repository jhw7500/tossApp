import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { verifyTossAnonymousKey } from '../src/auth/toss-client.ts';

test('accepts only the exact Toss success response', async () => {
  const verified = await verifyTossAnonymousKey('key', {
    certPath: '/tmp/cert', keyPath: '/tmp/key',
    request: async () => ({ statusCode: 200, body: '{"resultType":"SUCCESS","success":"true"}' }),
  });
  assert.equal(verified, true);
});

test('rejects string false and FAIL Toss responses', async () => {
  const base = { certPath: '/tmp/cert', keyPath: '/tmp/key' };
  assert.equal(await verifyTossAnonymousKey('key', { ...base, request: async () => ({ statusCode: 200, body: '{"resultType":"SUCCESS","success":"false"}' }) }), false);
  assert.equal(await verifyTossAnonymousKey('key', { ...base, request: async () => ({ statusCode: 200, body: '{"resultType":"SUCCESS","success":false}' }) }), false);
  await assert.rejects(() => verifyTossAnonymousKey('key', { ...base, request: async () => ({ statusCode: 200, body: '{"resultType":"FAIL","success":true}' }) }));
});

test('treats malformed and non-200 Toss responses as unavailable', async () => {
  await assert.rejects(() => verifyTossAnonymousKey('key', {
    certPath: '/tmp/cert', keyPath: '/tmp/key', request: async () => ({ statusCode: 200, body: '{not json' }),
  }));
  await assert.rejects(() => verifyTossAnonymousKey('key', {
    certPath: '/tmp/cert', keyPath: '/tmp/key', request: async () => ({ statusCode: 500, body: '{}' }),
  }));
});

test('default Toss transport settles on normal completion and partial abort', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tarororo-toss-'));
  const certPath = join(directory, 'cert.pem'); const keyPath = join(directory, 'key.pem');
  await Promise.all([writeFile(certPath, 'test-cert'), writeFile(keyPath, 'test-key')]);
  const originalRequest = https.request;
  try {
    let abort = false;
    https.request = ((options: { hostname: string; path: string; method: string }, callback: (response: EventEmitter & { statusCode?: number }) => void) => {
      assert.equal(options.hostname, 'apps-in-toss-api.toss.im'); assert.equal(options.path, '/api-partner/v1/apps-in-toss/users/anon-key/verify'); assert.equal(options.method, 'POST');
      const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
      request.end = () => {
        setImmediate(() => {
          const response = new EventEmitter() as EventEmitter & { statusCode: number };
          response.statusCode = 200; callback(response);
          response.emit('data', Buffer.from('{"resultType":"SUCCESS",'));
          if (abort) { response.emit('aborted'); response.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' })); response.emit('close'); } else { response.emit('data', Buffer.from('"success":true}')); response.emit('end'); }
        });
      };
      request.destroy = (error) => request.emit('error', error);
      return request;
    }) as typeof https.request;
    assert.equal(await verifyTossAnonymousKey('key', { certPath, keyPath }), true);
    abort = true;
    await assert.rejects(() => Promise.race([verifyTossAnonymousKey('key', { certPath, keyPath }), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))]), /abort|closed|disconnect/i);
  } finally { https.request = originalRequest; await rm(directory, { recursive: true, force: true }); }
});
