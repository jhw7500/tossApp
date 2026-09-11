import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { FoundationConfig } from '../config.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function createSession(pool: Pool, config: FoundationConfig, anonymousKey: string): Promise<{ token: string; expiresAt: string }> {
  const subjectHash = createHmac('sha256', config.subjectSecret).update(anonymousKey).digest('hex');
  const user = await pool.query('INSERT INTO users (id, subject_hash) VALUES ($1, $2) ON CONFLICT (subject_hash) DO UPDATE SET subject_hash = EXCLUDED.subject_hash RETURNING id', [randomUUID(), subjectHash]);
  const token = randomBytes(32).toString('base64url'); const expiresAt = new Date(Date.now() + 30 * 60_000);
  await pool.query('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [randomUUID(), user.rows[0].id, hash(token), expiresAt]);
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function sessionUserId(pool: Pool, token: string): Promise<string | undefined> {
  const session = await pool.query('SELECT user_id FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()', [hash(token)]);
  return session.rows[0]?.user_id;
}

export async function revokeSession(pool: Pool, token: string): Promise<boolean> {
  const result = await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()', [hash(token)]);
  return result.rowCount === 1;
}
