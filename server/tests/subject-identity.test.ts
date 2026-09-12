import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';

import { createSession, sessionUserId } from '../src/auth/sessions.ts';
import type { FoundationConfig } from '../src/config.ts';
import { createIsolatedPool, testConfig } from './helpers.ts';

function rotationConfig(activeVersion: string, activeSecret: string, previousSubjectSecrets: Array<{ version: string; secret: string }> = []): FoundationConfig {
  return {
    ...testConfig,
    subjectSecret: activeSecret,
    subjectSecretVersion: activeVersion,
    previousSubjectSecrets,
  };
}

function subjectHash(secret: string, anonymousKey: string): string {
  return createHmac('sha256', secret).update(anonymousKey).digest('hex');
}

test('rotates a subject secret without changing the user or losing owned records', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const anonymousKey = 'stable-anonymous-key';
  const oldSecret = 'a'.repeat(32);
  const activeSecret = 'b'.repeat(32);
  try {
    const oldSession = await createSession(pool, rotationConfig('v1', oldSecret), anonymousKey);
    const oldUserId = await sessionUserId(pool, oldSession.token);
    const personId = randomUUID();
    await pool.query(
      "INSERT INTO persons (id, user_id, nickname, relationship_code) VALUES ($1, $2, '민지', 'crush')",
      [personId, oldUserId],
    );

    const rotatedConfig = rotationConfig('v2', activeSecret, [{ version: 'v1', secret: oldSecret }]);
    const [rotatedSession, simultaneousRotatedSession] = await Promise.all([
      createSession(pool, rotatedConfig, anonymousKey),
      createSession(pool, rotatedConfig, anonymousKey),
    ]);
    const rotatedUserId = await sessionUserId(pool, rotatedSession.token);
    assert.equal(rotatedUserId, oldUserId);
    assert.equal(await sessionUserId(pool, simultaneousRotatedSession.token), oldUserId);
    assert.equal(await sessionUserId(pool, oldSession.token), oldUserId);
    assert.equal((await pool.query('SELECT user_id FROM persons WHERE id = $1', [personId])).rows[0].user_id, oldUserId);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, 1);

    const identities = await pool.query(
      'SELECT subject_hash, key_version FROM user_subject_identities WHERE user_id = $1 ORDER BY subject_hash',
      [oldUserId],
    );
    assert.deepEqual(new Set(identities.rows.map((row) => row.subject_hash.trim())), new Set([
      subjectHash(oldSecret, anonymousKey),
      subjectHash(activeSecret, anonymousKey),
    ]));
    assert.ok(identities.rows.every((row) => row.subject_hash.trim() !== anonymousKey));
    assert.equal((await pool.query('SELECT subject_hash FROM users WHERE id = $1', [oldUserId])).rows[0].subject_hash.trim(), subjectHash(activeSecret, anonymousKey));

    const afterWindow = await createSession(pool, rotationConfig('v2', activeSecret), anonymousKey);
    assert.equal(await sessionUserId(pool, afterWindow.token), oldUserId);
  } finally {
    await dispose();
  }
});

test('concurrent first sessions converge on one user identity', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const config = rotationConfig('v1', 'a'.repeat(32));
  try {
    const sessions = await Promise.all(Array.from({ length: 8 }, () => createSession(pool, config, 'concurrent-key')));
    const userIds = await Promise.all(sessions.map((session) => sessionUserId(pool, session.token)));
    assert.equal(new Set(userIds).size, 1);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM user_subject_identities')).rows[0].count, 1);
  } finally {
    await dispose();
  }
});

test('mixed active-key versions converge when the newer version creates the user first', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const oldSecret = 'a'.repeat(32);
  const activeSecret = 'b'.repeat(32);
  const oldConfig = rotationConfig('v1', oldSecret);
  const activeConfig = rotationConfig('v2', activeSecret, [{ version: 'v1', secret: oldSecret }]);
  try {
    const newerSession = await createSession(pool, activeConfig, 'mixed-version-key');
    const olderSession = await createSession(pool, oldConfig, 'mixed-version-key');
    assert.equal(await sessionUserId(pool, olderSession.token), await sessionUserId(pool, newerSession.token));
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, 1);

    const concurrentSessions = await Promise.all([
      createSession(pool, activeConfig, 'concurrent-mixed-key'),
      createSession(pool, oldConfig, 'concurrent-mixed-key'),
      createSession(pool, activeConfig, 'concurrent-mixed-key'),
      createSession(pool, oldConfig, 'concurrent-mixed-key'),
    ]);
    const concurrentUserIds = await Promise.all(concurrentSessions.map((session) => sessionUserId(pool, session.token)));
    assert.equal(new Set(concurrentUserIds).size, 1);
  } finally {
    await dispose();
  }
});

test('adopts a user inserted by legacy code after migration 004', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const anonymousKey = 'post-migration-legacy-key';
  const oldSecret = 'a'.repeat(32);
  const activeSecret = 'b'.repeat(32);
  const legacyUserId = randomUUID();
  try {
    await pool.query('INSERT INTO users (id, subject_hash) VALUES ($1, $2)', [legacyUserId, subjectHash(oldSecret, anonymousKey)]);
    assert.deepEqual(
      (await pool.query('SELECT user_id, key_version FROM user_subject_identities WHERE subject_hash = $1', [subjectHash(oldSecret, anonymousKey)])).rows,
      [{ user_id: legacyUserId, key_version: 'legacy' }],
    );

    const session = await createSession(
      pool,
      rotationConfig('v2', activeSecret, [{ version: 'v1', secret: oldSecret }]),
      anonymousKey,
    );
    assert.equal(await sessionUserId(pool, session.token), legacyUserId);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, 1);
  } finally {
    await dispose();
  }
});

test('fails closed when old and active identities already belong to different users', async () => {
  const { pool, dispose } = await createIsolatedPool();
  const anonymousKey = 'conflicted-key';
  const oldSecret = 'a'.repeat(32);
  const activeSecret = 'b'.repeat(32);
  const oldUserId = randomUUID();
  const activeUserId = randomUUID();
  try {
    await pool.query(
      'INSERT INTO users (id, subject_hash) VALUES ($1, $2), ($3, $4)',
      [oldUserId, subjectHash(oldSecret, anonymousKey), activeUserId, subjectHash(activeSecret, anonymousKey)],
    );

    await assert.rejects(
      () => createSession(pool, rotationConfig('v2', activeSecret, [{ version: 'v1', secret: oldSecret }]), anonymousKey),
      /subject identity conflict/i,
    );
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM sessions')).rows[0].count, 0);
  } finally {
    await dispose();
  }
});
