import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../errors.ts';
import { expireLockedReading, expireReading, lockCurrentAttempt } from './attempts.ts';
import { MAX_READING_ATTEMPTS, READING_CONTRACT_VERSION, READING_PROMPT_VERSION } from './constants.ts';
import { buildReadingSnapshot } from './snapshot.ts';
import { inTransaction } from './transaction.ts';
import type { AcceptedReading, CreateReadingBody, ReadingDetail, ReadingHistory, ReadingRow, ReadingSnapshot, RetryReadingBody } from './types.ts';

export interface ReadingAcceptance { replayed: boolean; reading: AcceptedReading; }
const statusUrl = (id: string) => `/v1/readings/${id}`;
const hashRequest = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

export function normalizeReadingRequest(body: CreateReadingBody): CreateReadingBody {
  const selections = body.selections.map(selection => ({ positionIndex: selection.positionIndex, cardId: selection.cardId.toLowerCase() })).sort((a, b) => a.positionIndex - b.positionIndex);
  if (new Set(selections.map(item => item.cardId)).size !== 3 || selections.map(item => item.positionIndex).join(',') !== '1,2,3') {
    throw new HttpError(400, 'INVALID_INPUT', 'three distinct cards and positions are required');
  }
  const customText = body.question.customText?.trim();
  if (customText !== undefined && (!customText || Array.from(customText).length > 500)) {
    throw new HttpError(400, 'INVALID_INPUT', 'customText must contain 1 to 500 code points');
  }
  return {
    personId: body.personId.toLowerCase(), personVersion: body.personVersion,
    question: { id: body.question.id.toLowerCase(), version: body.question.version, ...(customText === undefined ? {} : { customText }) },
    selections: selections as CreateReadingBody['selections'],
  };
}

async function replayRequest(client: PoolClient, userId: string, operation: string, key: string, hash: string): Promise<ReadingAcceptance | null> {
  const request = (await client.query(`
    SELECT i.request_hash, i.reading_id, a.attempt_no, a.status
    FROM idempotency_requests i JOIN reading_attempts a ON a.id = i.attempt_id
    WHERE i.user_id = $1 AND i.operation = $2 AND i.key = $3
  `, [userId, operation, key])).rows[0];
  if (!request) return null;
  if (request.request_hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'idempotency key has different input');
  return { replayed: true, reading: { readingId: request.reading_id, attemptNo: request.attempt_no, status: request.status, statusUrl: statusUrl(request.reading_id) } };
}

async function assertAvailableUser(client: PoolClient, userId: string): Promise<void> {
  const active = await client.query<ReadingRow>("SELECT * FROM readings WHERE user_id = $1 AND status IN ('QUEUED', 'RUNNING') ORDER BY id FOR UPDATE", [userId]);
  for (const reading of active.rows) {
    if (!await expireLockedReading(client, reading)) throw new HttpError(429, 'RATE_LIMITED', 'another reading is active', true);
  }
}

async function insertAttempt(client: PoolClient, userId: string, readingId: string, attemptNo: number, operation: string, key: string, hash: string): Promise<ReadingAcceptance> {
  const attemptId = randomUUID();
  await client.query("INSERT INTO reading_attempts(id, reading_id, attempt_no, status) VALUES ($1, $2, $3, 'QUEUED')", [attemptId, readingId, attemptNo]);
  await client.query('INSERT INTO idempotency_requests(user_id, operation, key, request_hash, reading_id, attempt_id) VALUES ($1,$2,$3,$4,$5,$6)', [userId, operation, key, hash, readingId, attemptId]);
  return { replayed: false, reading: { readingId, attemptNo, status: 'QUEUED', statusUrl: statusUrl(readingId) } };
}

async function persistSnapshot(client: PoolClient, readingId: string, snapshot: ReadingSnapshot): Promise<void> {
  for (const card of snapshot.cards) {
    const readingCardId = randomUUID();
    const { candidates, positionIndex, label, description, ...metadata } = card;
    await client.query('INSERT INTO reading_cards(id, reading_id, card_id, position_index, card_snapshot, position_snapshot) VALUES ($1,$2,$3,$4,$5,$6)', [readingCardId, readingId, card.cardId, positionIndex, metadata, { positionIndex, label, description }]);
    for (const candidate of candidates) {
      await client.query('INSERT INTO reading_evidence(reading_card_id, interpretation_id, version, text_snapshot, metadata_snapshot) VALUES ($1,$2,$3,$4,$5)', [readingCardId, candidate.interpretationId, candidate.version, candidate.text, { sourceKind: candidate.sourceKind, sourceAttribution: candidate.sourceAttribution }]);
    }
  }
}

export async function createReading(pool: Pool, userId: string, key: string, rawBody: CreateReadingBody, production = false): Promise<ReadingAcceptance> {
  const body = normalizeReadingRequest(rawBody);
  const hash = hashRequest(body);
  return inTransaction(pool, async client => {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const replay = await replayRequest(client, userId, 'create-reading', key, hash);
    if (replay) return replay;
    const snapshot = await buildReadingSnapshot(client, userId, body, production);
    await assertAvailableUser(client, userId);
    const readingId = randomUUID();
    await client.query(`
      INSERT INTO readings(id, user_id, person_id, status, current_attempt_no, request_snapshot, contract_version, prompt_version)
      VALUES ($1,$2,$3,'QUEUED',1,$4,$5,$6)
    `, [readingId, userId, body.personId, snapshot, READING_CONTRACT_VERSION, READING_PROMPT_VERSION]);
    await persistSnapshot(client, readingId, snapshot);
    return insertAttempt(client, userId, readingId, 1, 'create-reading', key, hash);
  });
}

export async function retryReading(pool: Pool, userId: string, readingId: string, key: string, body: RetryReadingBody): Promise<ReadingAcceptance> {
  // Expiration commits independently even when the following retry is rejected.
  await expireReading(pool, readingId, userId);
  const operation = 'retry-reading';
  const hash = hashRequest({ readingId: readingId.toLowerCase(), expectedAttemptNo: body.expectedAttemptNo });
  return inTransaction(pool, async client => {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const replay = await replayRequest(client, userId, operation, key, hash);
    if (replay) return replay;
    const reading = (await client.query<ReadingRow>('SELECT * FROM readings WHERE id = $1 AND user_id = $2 FOR UPDATE', [readingId, userId])).rows[0];
    if (!reading) throw new HttpError(404, 'NOT_FOUND', 'reading not found');
    const attempt = await lockCurrentAttempt(client, reading);
    if (reading.status !== 'FAILED' || attempt.status !== 'FAILED' || reading.current_attempt_no !== body.expectedAttemptNo
      || !attempt.error_json?.retryable || reading.current_attempt_no >= MAX_READING_ATTEMPTS) {
      throw new HttpError(409, 'RETRY_NOT_ALLOWED', 'reading cannot be retried');
    }
    await assertAvailableUser(client, userId);
    const next = reading.current_attempt_no + 1;
    await client.query("UPDATE readings SET status = 'QUEUED', current_attempt_no = $2, error_json = NULL, updated_at = clock_timestamp() WHERE id = $1", [readingId, next]);
    return insertAttempt(client, userId, readingId, next, operation, key, hash);
  });
}

export async function getReading(pool: Pool, userId: string, readingId: string): Promise<ReadingDetail> {
  await expireReading(pool, readingId, userId);
  const reading = (await pool.query<ReadingRow>('SELECT * FROM readings WHERE id = $1 AND user_id = $2', [readingId, userId])).rows[0];
  if (!reading) throw new HttpError(404, 'NOT_FOUND', 'reading not found');
  const snapshot = reading.request_snapshot;
  return {
    id: reading.id, personId: reading.person_id, status: reading.status, attemptNo: reading.current_attempt_no,
    createdAt: reading.created_at.toISOString(), updatedAt: reading.updated_at.toISOString(),
    input: {
      personNickname: snapshot.person.nickname, relationshipCode: snapshot.person.relationshipCode,
      currentSituation: snapshot.person.currentSituation, question: snapshot.question,
      cards: snapshot.cards.map(({ cardId, name, positionIndex, label }) => ({ cardId, name, positionIndex, label })),
    },
    result: reading.status === 'SUCCEEDED' ? reading.result_json : null,
    error: reading.status === 'FAILED' ? reading.error_json : null,
    aiGenerated: reading.status === 'SUCCEEDED' && reading.ai_generated, testContent: snapshot.testContent,
  };
}

export function parseReadingCursor(value: string): { createdAt: string; id: string } {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error();
    const [createdAt, id, extra] = Buffer.from(value, 'base64url').toString('utf8').split('|');
    if (extra !== undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error();
    const date = new Date(createdAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 23) !== createdAt.slice(0, 23)) throw new Error();
    return { createdAt, id };
  } catch { throw new HttpError(400, 'INVALID_INPUT', 'invalid cursor'); }
}

export async function listReadings(pool: Pool, userId: string, personId: string, query: { cursor?: string; limit?: string }): Promise<ReadingHistory> {
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'INVALID_INPUT', 'invalid limit');
  const cursor = query.cursor === undefined ? undefined : parseReadingCursor(query.cursor);
  if (!(await pool.query('SELECT 1 FROM persons WHERE id = $1 AND user_id = $2', [personId, userId])).rowCount) throw new HttpError(404, 'NOT_FOUND', 'person not found');
  const rows = await pool.query<ReadingRow & { cursor_time: string }>(`
    SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM readings WHERE user_id = $1 AND person_id = $2
      AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
    ORDER BY created_at DESC, id DESC LIMIT $5
  `, [userId, personId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]);
  const page = rows.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(row => ({ id: row.id, status: row.status, question: row.request_snapshot.question.text, summary: row.result_json?.summary ?? null, createdAt: row.created_at.toISOString() })),
    nextCursor: rows.rows.length > limit && last ? Buffer.from(`${last.cursor_time}|${last.id}`).toString('base64url') : null,
  };
}
