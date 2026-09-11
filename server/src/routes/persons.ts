import { randomUUID } from 'node:crypto';
import type { FromSchema } from 'json-schema-to-ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { personCreateBodySchema, personPatchBodySchema, personSchema } from '../../../contracts/foundation.schemas.ts';
import { HttpError } from '../errors.ts';

type CreatePerson = FromSchema<typeof personCreateBodySchema>;
type PatchPerson = FromSchema<typeof personPatchBodySchema>;
export type PersonDto = FromSchema<typeof personSchema>;
type PersonRow = { id: string; nickname: string; relationshipCode: string; currentSituation: string | null; version: number; createdAt: Date; updatedAt: Date; readingCount: number; lastReadingAt: Date | null };
type PersonListRow = PersonRow & { __cursorCreatedAt: string };
const personFields = 'id, nickname, relationship_code AS "relationshipCode", current_situation AS "currentSituation", version, created_at AS "createdAt", updated_at AS "updatedAt", (SELECT count(*)::integer FROM readings r WHERE r.person_id = persons.id AND r.status = \'SUCCEEDED\') AS "readingCount", (SELECT max(r.updated_at) FROM readings r WHERE r.person_id = persons.id AND r.status = \'SUCCEEDED\') AS "lastReadingAt"';
const listPersonFields = `${personFields}, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "__cursorCreatedAt"`;
const personIdParamsSchema = { type: 'object', additionalProperties: false, required: ['personId'], properties: { personId: { type: 'string', format: 'uuid' } } } as const;
const personsQuerySchema = { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string' }, limit: { type: 'string' } } } as const;
const noQuerySchema = { type: 'object', additionalProperties: false } as const;
const dto = ({ __cursorCreatedAt: _cursorCreatedAt, ...row }: PersonRow & Partial<PersonListRow>): PersonDto => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), lastReadingAt: row.lastReadingAt?.toISOString() ?? null });
const codePoints = (value: string): number => Array.from(value).length;
function normalizeText(value: string, field: 'nickname' | 'currentSituation'): string { const text = value.trim(); const max = field === 'nickname' ? 30 : 2000; if (!text || codePoints(text) > max) throw new HttpError(400, 'INVALID_INPUT', `invalid ${field}`); return text; }
async function assertRelationship(pool: Pool, code: string): Promise<void> { if (!(await pool.query('SELECT 1 FROM relationship_types WHERE code = $1', [code])).rowCount) throw new HttpError(400, 'INVALID_INPUT', 'invalid relationshipCode'); }
const owner = (request: FastifyRequest): string => request.userId!;
function parseCursor(value: string): { createdAt: string; id: string } {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error();
    const parts = Buffer.from(value, 'base64url').toString('utf8').split('|'); if (parts.length !== 2) throw new Error();
    const [createdAt, id] = parts; const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(createdAt);
    if (!timestamp || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error();
    const values = timestamp.slice(1).map(Number); const calendar = new Date(Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4], values[5], Math.floor(values[6] / 1000)));
    if (calendar.getUTCFullYear() !== values[0] || calendar.getUTCMonth() !== values[1] - 1 || calendar.getUTCDate() !== values[2] || calendar.getUTCHours() !== values[3] || calendar.getUTCMinutes() !== values[4] || calendar.getUTCSeconds() !== values[5]) throw new Error();
    return { createdAt, id };
  } catch { throw new HttpError(400, 'INVALID_INPUT', 'invalid cursor'); }
}

export function registerPersonRoutes(app: FastifyInstance, pool: Pool): void {
  app.post<{ Body: CreatePerson }>('/v1/persons', { schema: { body: personCreateBodySchema, querystring: noQuerySchema } }, async (request, reply) => {
    const body = request.body; const nickname = normalizeText(body.nickname, 'nickname'); const situation = body.currentSituation === undefined ? null : body.currentSituation === null ? null : normalizeText(body.currentSituation, 'currentSituation'); await assertRelationship(pool, body.relationshipCode);
    const result = await pool.query<PersonRow>(`INSERT INTO persons (id, user_id, nickname, relationship_code, current_situation) VALUES ($1, $2, $3, $4, $5) RETURNING ${personFields}`, [randomUUID(), owner(request), nickname, body.relationshipCode, situation]);
    return reply.status(201).send(dto(result.rows[0]));
  });
  app.get<{ Params: { personId: string } }>('/v1/persons/:personId', { schema: { params: personIdParamsSchema, querystring: noQuerySchema } }, async (request) => { const result = await pool.query<PersonRow>(`SELECT ${personFields} FROM persons WHERE id = $1 AND user_id = $2`, [request.params.personId, owner(request)]); if (!result.rowCount) throw new HttpError(404, 'NOT_FOUND', 'person not found'); return dto(result.rows[0]); });
  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/v1/persons', { schema: { querystring: personsQuerySchema } }, async (request) => {
    const limit = request.query.limit === undefined ? 20 : Number(request.query.limit); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'INVALID_INPUT', 'invalid limit'); const cursor = request.query.cursor === undefined ? undefined : parseCursor(request.query.cursor);
    const query = cursor ? `SELECT ${listPersonFields} FROM persons WHERE user_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid) ORDER BY created_at DESC, id DESC LIMIT $4` : `SELECT ${listPersonFields} FROM persons WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`;
    const values = cursor ? [owner(request), cursor.createdAt, cursor.id, limit + 1] : [owner(request), limit + 1]; const result = await pool.query<PersonListRow>(query, values); const rows = result.rows.slice(0, limit); const last = rows.at(-1);
    return { items: rows.map(dto), nextCursor: result.rows.length > limit && last ? Buffer.from(`${last.__cursorCreatedAt}|${last.id}`).toString('base64url') : null };
  });
  app.patch<{ Params: { personId: string }; Body: PatchPerson }>('/v1/persons/:personId', { schema: { body: personPatchBodySchema, params: personIdParamsSchema, querystring: noQuerySchema } }, async (request) => {
    const body = request.body; if (body.relationshipCode !== undefined) await assertRelationship(pool, body.relationshipCode); const nickname = body.nickname === undefined ? undefined : normalizeText(body.nickname, 'nickname'); const situation = body.currentSituation === undefined ? undefined : body.currentSituation === null ? null : normalizeText(body.currentSituation, 'currentSituation');
    const current = await pool.query<PersonRow>(`SELECT ${personFields} FROM persons WHERE id = $1 AND user_id = $2`, [request.params.personId, owner(request)]); if (!current.rowCount) throw new HttpError(404, 'NOT_FOUND', 'person not found');
    const result = await pool.query<PersonRow>(`UPDATE persons SET nickname = COALESCE($1, nickname), relationship_code = COALESCE($2, relationship_code), current_situation = CASE WHEN $3 THEN $4 ELSE current_situation END, version = version + 1, updated_at = now() WHERE id = $5 AND user_id = $6 AND version = $7 RETURNING ${personFields}`, [nickname ?? null, body.relationshipCode ?? null, body.currentSituation !== undefined, situation ?? null, request.params.personId, owner(request), body.version]); if (!result.rowCount) throw new HttpError(409, 'VERSION_CONFLICT', 'person was updated by another request'); return dto(result.rows[0]);
  });
}
