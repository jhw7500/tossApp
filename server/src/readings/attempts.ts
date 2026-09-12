import type { Pool, PoolClient } from 'pg';
import { LEASE_SECONDS, MAX_READING_ATTEMPTS, QUEUE_TIMEOUT_SECONDS } from './constants.ts';
import { inTransaction } from './transaction.ts';
import type { AttemptRow, ReadingClaim, ReadingCompletion, ReadingFailure, ReadingRow } from './types.ts';

export function normalizeFailureCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'AI_UNAVAILABLE';
}

export async function lockCurrentAttempt(client: PoolClient, reading: ReadingRow): Promise<AttemptRow> {
  return (await client.query<AttemptRow>(
    'SELECT * FROM reading_attempts WHERE reading_id = $1 AND attempt_no = $2 FOR UPDATE',
    [reading.id, reading.current_attempt_no],
  )).rows[0];
}

export async function expireLockedReading(client: PoolClient, reading: ReadingRow): Promise<boolean> {
  if (!['QUEUED', 'RUNNING'].includes(reading.status)) return false;
  const attempt = await lockCurrentAttempt(client, reading);
  const expired = await client.query(`
    SELECT (status = 'QUEUED' AND queued_at <= clock_timestamp() - $2 * interval '1 second')
      OR (status = 'RUNNING' AND lease_expires_at <= clock_timestamp()) AS expired
    FROM reading_attempts WHERE id = $1
  `, [attempt.id, QUEUE_TIMEOUT_SECONDS]);
  if (!expired.rows[0].expired) return false;
  const error = {
    code: attempt.status === 'QUEUED' ? 'QUEUE_TIMEOUT' : 'WORKER_TIMEOUT',
    message: attempt.status === 'QUEUED' ? 'reading waited too long in the queue' : 'reading worker timed out',
    retryable: attempt.attempt_no < MAX_READING_ATTEMPTS,
  };
  await client.query("UPDATE reading_attempts SET status = 'FAILED', error_json = $2, finished_at = clock_timestamp() WHERE id = $1", [attempt.id, error]);
  await client.query("UPDATE readings SET status = 'FAILED', error_json = $2, updated_at = clock_timestamp() WHERE id = $1", [reading.id, error]);
  reading.status = 'FAILED';
  reading.error_json = error;
  return true;
}

export async function expireReading(pool: Pool, readingId: string, userId: string): Promise<void> {
  await inTransaction(pool, async client => {
    const reading = (await client.query<ReadingRow>('SELECT * FROM readings WHERE id = $1 AND user_id = $2 FOR UPDATE', [readingId, userId])).rows[0];
    if (reading) await expireLockedReading(client, reading);
  });
}

export async function expireReadings(pool: Pool): Promise<number> {
  return inTransaction(pool, async client => {
    const readings = await client.query<ReadingRow>(`
      SELECT r.* FROM readings r WHERE r.status IN ('QUEUED', 'RUNNING') AND EXISTS (
        SELECT 1 FROM reading_attempts a WHERE a.reading_id = r.id AND a.attempt_no = r.current_attempt_no
        AND ((a.status = 'QUEUED' AND a.queued_at <= clock_timestamp() - $1 * interval '1 second')
          OR (a.status = 'RUNNING' AND a.lease_expires_at <= clock_timestamp()))
      ) ORDER BY r.id FOR UPDATE OF r SKIP LOCKED
    `, [QUEUE_TIMEOUT_SECONDS]);
    let count = 0;
    for (const reading of readings.rows) if (await expireLockedReading(client, reading)) count++;
    return count;
  });
}

export async function claimNextReading(pool: Pool, options: { provider: string; model: string }): Promise<ReadingClaim | null> {
  return inTransaction(pool, async client => {
    // Expired queued jobs are finalized, never claimed for an external call.
    for (;;) {
      const reading = (await client.query<ReadingRow>(`
        SELECT * FROM readings WHERE status = 'QUEUED'
        ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      `)).rows[0];
      if (!reading) return null;
      if (await expireLockedReading(client, reading)) continue;
      const attempt = await lockCurrentAttempt(client, reading);
      const claimed = await client.query<{ lease_expires_at: Date }>(`
        UPDATE reading_attempts SET status = 'RUNNING', claimed_at = clock_timestamp(),
          lease_expires_at = clock_timestamp() + $2 * interval '1 second', provider = $3, model = $4
        WHERE id = $1 RETURNING lease_expires_at
      `, [attempt.id, LEASE_SECONDS, options.provider, options.model]);
      await client.query("UPDATE readings SET status = 'RUNNING', updated_at = clock_timestamp() WHERE id = $1", [reading.id]);
      return {
        readingId: reading.id, attemptId: attempt.id, attemptNo: attempt.attempt_no,
        snapshot: reading.request_snapshot, promptVersion: reading.prompt_version,
        contractVersion: reading.contract_version, leaseExpiresAt: claimed.rows[0].lease_expires_at.toISOString(),
      };
    }
  });
}

async function lockLiveClaim(client: PoolClient, claim: ReadingClaim): Promise<ReadingRow | null> {
  const reading = (await client.query<ReadingRow>('SELECT * FROM readings WHERE id = $1 FOR UPDATE', [claim.readingId])).rows[0];
  if (!reading || reading.status !== 'RUNNING' || reading.current_attempt_no !== claim.attemptNo) return null;
  const attempt = await lockCurrentAttempt(client, reading);
  if (attempt.id !== claim.attemptId || attempt.status !== 'RUNNING') return null;
  const live = await client.query('SELECT lease_expires_at > clock_timestamp() AS live FROM reading_attempts WHERE id = $1', [attempt.id]);
  return live.rows[0].live ? reading : null;
}

async function assertStoredEvidence(client: PoolClient, reading: ReadingRow, completion: ReadingCompletion): Promise<void> {
  const result = completion.result;
  const validText = (text: unknown, max: number) => typeof text === 'string' && text.trim().length > 0 && Array.from(text).length <= max;
  const exactKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
  if (!result || !exactKeys(result, ['cards', 'overallReading', 'summary']) || !Array.isArray(result.cards) || result.cards.length !== 3
    || !validText(result.overallReading, 2000) || !validText(result.summary, 120)) throw new Error('AI output is invalid');
  const positions = new Set<number>();
  for (const card of result.cards) {
    if (!card || !exactKeys(card, ['cardId', 'positionIndex', 'text', 'evidence']) || positions.has(card.positionIndex)
      || !validText(card.text, 800) || !Array.isArray(card.evidence) || !card.evidence.length || card.evidence.length > 20) throw new Error('AI output is invalid');
    positions.add(card.positionIndex);
    const input = reading.request_snapshot.cards.find(item => item.positionIndex === card.positionIndex && item.cardId === card.cardId);
    if (!input) throw new Error('AI output card is invalid');
    const pairs = new Set<string>();
    for (const evidence of card.evidence) {
      if (!evidence || !exactKeys(evidence, ['interpretationId', 'version'])
        || !input.candidates.some(candidate => candidate.interpretationId === evidence.interpretationId && candidate.version === evidence.version)) throw new Error('AI output evidence is invalid');
      const pair = `${evidence.interpretationId}:${evidence.version}`;
      if (pairs.has(pair)) throw new Error('AI output evidence is duplicated');
      pairs.add(pair);
      const stored = await client.query(`
        SELECT 1 FROM reading_evidence e JOIN reading_cards c ON c.id = e.reading_card_id
        WHERE c.reading_id = $1 AND c.card_id = $2 AND c.position_index = $3
          AND e.interpretation_id = $4 AND e.version = $5
      `, [reading.id, card.cardId, card.positionIndex, evidence.interpretationId, evidence.version]);
      if (!stored.rowCount) throw new Error('AI output evidence is not a stored candidate');
    }
  }
}

export async function completeReading(pool: Pool, claim: ReadingClaim, completion: ReadingCompletion): Promise<boolean> {
  return inTransaction(pool, async client => {
    const reading = await lockLiveClaim(client, claim);
    if (!reading) return false;
    await assertStoredEvidence(client, reading, completion);
    const finished = await client.query(`
      UPDATE reading_attempts SET status = 'SUCCEEDED', finished_at = clock_timestamp(), usage = $2
      WHERE id = $1 AND status = 'RUNNING' AND lease_expires_at > clock_timestamp() RETURNING id
    `, [claim.attemptId, completion.usage]);
    if (!finished.rowCount) return false;
    for (const card of completion.result.cards) for (const evidence of card.evidence) {
      await client.query(`
        UPDATE reading_evidence e SET selected = true FROM reading_cards c
        WHERE c.id = e.reading_card_id AND c.reading_id = $1 AND c.card_id = $2 AND c.position_index = $3
          AND e.interpretation_id = $4 AND e.version = $5
      `, [reading.id, card.cardId, card.positionIndex, evidence.interpretationId, evidence.version]);
    }
    await client.query(`
      UPDATE readings SET status = 'SUCCEEDED', result_json = $2, error_json = NULL,
        ai_generated = $3, updated_at = clock_timestamp() WHERE id = $1
    `, [reading.id, completion.result, completion.aiGenerated === true]);
    return true;
  });
}

export async function failReading(pool: Pool, claim: ReadingClaim, failure: ReadingFailure): Promise<boolean> {
  return inTransaction(pool, async client => {
    const reading = await lockLiveClaim(client, claim);
    if (!reading) return false;
    // Failure messages originate at an external boundary; never persist provider bodies publicly.
    const error = {
      code: normalizeFailureCode(failure.code),
      message: 'reading could not be completed',
      retryable: failure.retryable && claim.attemptNo < MAX_READING_ATTEMPTS,
    };
    const finished = await client.query(`
      UPDATE reading_attempts SET status = 'FAILED', error_json = $2, finished_at = clock_timestamp()
      WHERE id = $1 AND status = 'RUNNING' AND lease_expires_at > clock_timestamp() RETURNING id
    `, [claim.attemptId, error]);
    if (!finished.rowCount) return false;
    await client.query("UPDATE readings SET status = 'FAILED', error_json = $2, updated_at = clock_timestamp() WHERE id = $1", [reading.id, error]);
    return true;
  });
}
