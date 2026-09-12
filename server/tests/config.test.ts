import assert from 'node:assert/strict';
import test from 'node:test';

import * as configuration from '../src/config.ts';
const { readConfig } = configuration;

test('worker starts with DB and AI settings without API authentication secrets', () => {
  assert.equal(typeof configuration.readWorkerConfig, 'function');
  const config = configuration.readWorkerConfig({ DATABASE_URL: 'postgresql://db/test', GEMINI_API_KEY: 'worker-only' });
  assert.equal(config.databaseUrl, 'postgresql://db/test');
  assert.equal(config.ai.apiKey, 'worker-only');
  assert.equal(config.ai.provider, 'gemini');
  assert.throws(() => configuration.readWorkerConfig({ GEMINI_API_KEY: 'worker-only' }), /DATABASE_URL/);
  assert.throws(() => configuration.readWorkerConfig({ DATABASE_URL: '   ', GEMINI_API_KEY: 'worker-only' }), /DATABASE_URL/);
  assert.throws(() => configuration.readWorkerConfig({ DATABASE_URL: 'postgresql://db/test' }), /GEMINI_API_KEY/);
});

test('rejects mock authentication in production', () => {
  assert.throws(
    () => readConfig({
      APP_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '3000',
      DATABASE_URL: 'postgresql://example',
      AUTH_MODE: 'mock',
      AUTH_SUBJECT_SECRET: 'a'.repeat(32),
      ALLOWED_ORIGINS: 'https://tarororo.example',
    }),
    /mock authentication/i,
  );
});

test('accepts a loopback mock configuration for tests', () => {
  const config = readConfig({
    APP_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3100',
    DATABASE_URL: 'postgresql://example',
    AUTH_MODE: 'mock',
    AUTH_SUBJECT_SECRET: 'a'.repeat(32),
    ALLOWED_ORIGINS: 'http://localhost:3000',
  });
  assert.equal(config.authMode, 'mock');
  assert.equal(config.port, 3100);
});

test('rejects every production loopback origin form', () => {
  for (const origin of ['https://127.0.0.2', 'https://127.255.255.254', 'https://[::1]', 'https://[::ffff:127.0.0.1]']) {
    assert.throws(() => readConfig({ APP_ENV: 'production', HOST: '0.0.0.0', PORT: '3000', DATABASE_URL: 'postgresql://example', AUTH_MODE: 'toss', AUTH_SUBJECT_SECRET: 'a'.repeat(32), ALLOWED_ORIGINS: origin, TOSS_MTLS_CERT_PATH: '/tmp/cert', TOSS_MTLS_KEY_PATH: '/tmp/key' }), /non-loopback/i);
  }
});

test('does not treat public mapped-looking IPv6 as loopback', () => {
  assert.throws(() => readConfig({ APP_ENV: 'local', HOST: '2001:db8::ffff:7f00:1', PORT: '3000', DATABASE_URL: 'postgresql://example', AUTH_MODE: 'mock', AUTH_SUBJECT_SECRET: 'a'.repeat(32), ALLOWED_ORIGINS: 'http://localhost:3000' }), /loopback host/i);
  assert.doesNotThrow(() => readConfig({ APP_ENV: 'production', HOST: '0.0.0.0', PORT: '3000', DATABASE_URL: 'postgresql://example', AUTH_MODE: 'toss', AUTH_SUBJECT_SECRET: 'a'.repeat(32), ALLOWED_ORIGINS: 'https://[2001:db8::ffff:7f00:1]', TOSS_MTLS_CERT_PATH: '/tmp/cert', TOSS_MTLS_KEY_PATH: '/tmp/key' }));
});
