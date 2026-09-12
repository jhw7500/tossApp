import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResult } from 'pg';

import type { FoundationConfig } from '../config.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const subjectHash = (secret: string, anonymousKey: string): string => createHmac('sha256', secret).update(anonymousKey).digest('hex');

class SubjectIdentityConflictError extends Error {
  constructor() {
    super('subject identity conflict');
    this.name = 'SubjectIdentityConflictError';
  }
}

async function resolveUserId(client: PoolClient, config: FoundationConfig, anonymousKey: string): Promise<string> {
  const activeHash = subjectHash(config.subjectSecret, anonymousKey);
  const candidates = new Map<string, string>([[activeHash, config.subjectSecretVersion]]);
  for (const { version, secret } of config.previousSubjectSecrets) {
    const candidateHash = subjectHash(secret, anonymousKey);
    if (!candidates.has(candidateHash)) candidates.set(candidateHash, version);
  }
  const candidateHashes = [...candidates.keys()].sort();
  for (const candidateHash of candidateHashes) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [candidateHash]);
  }
  const existing = await client.query<{ subject_hash: string; user_id: string }>(
    'SELECT subject_hash, user_id FROM user_subject_identities WHERE subject_hash = ANY($1::char(64)[]) FOR UPDATE',
    [candidateHashes],
  );
  const legacyUsers = await client.query<{ subject_hash: string; user_id: string }>(
    'SELECT subject_hash, id AS user_id FROM users WHERE subject_hash = ANY($1::char(64)[]) FOR UPDATE',
    [candidateHashes],
  );
  const existingUserIds = new Set([...existing.rows, ...legacyUsers.rows].map((row) => row.user_id));
  if (existingUserIds.size > 1) throw new SubjectIdentityConflictError();

  let userId = existingUserIds.values().next().value as string | undefined;
  if (!userId) {
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (id, subject_hash) VALUES ($1, $2) ON CONFLICT (subject_hash) DO UPDATE SET subject_hash = EXCLUDED.subject_hash RETURNING id',
      [randomUUID(), activeHash],
    );
    userId = user.rows[0].id;
  }

  for (const [candidateHash, version] of [...candidates.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const identity: QueryResult<{ user_id: string }> = await client.query<{ user_id: string }>(
      `INSERT INTO user_subject_identities (subject_hash, user_id, key_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (subject_hash) DO UPDATE SET key_version = EXCLUDED.key_version
       RETURNING user_id`,
      [candidateHash, userId, version],
    );
    if (identity.rows[0].user_id !== userId) throw new SubjectIdentityConflictError();
  }

  try {
    await client.query('UPDATE users SET subject_hash = $1 WHERE id = $2 AND subject_hash <> $1', [activeHash, userId]);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new SubjectIdentityConflictError();
    throw error;
  }
  return userId;
}

export async function createSession(pool: Pool, config: FoundationConfig, anonymousKey: string): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = await resolveUserId(client, config, anonymousKey);
    await client.query(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [randomUUID(), userId, hash(token), expiresAt],
    );
    await client.query('COMMIT');
    return { token, expiresAt: expiresAt.toISOString() };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function sessionUserId(pool: Pool, token: string): Promise<string | undefined> {
  const session = await pool.query('SELECT user_id FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()', [hash(token)]);
  return session.rows[0]?.user_id;
}

export async function revokeSession(pool: Pool, token: string): Promise<boolean> {
  const result = await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()', [hash(token)]);
  return result.rowCount === 1;
}
