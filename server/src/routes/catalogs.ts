import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { questionCatalogSchema, relationshipTypeListSchema, tarotCardCatalogSchema } from '../../../contracts/foundation.schemas.ts';
import { SOURCE_WHITESPACE } from '../readings/constants.ts';
import { HttpError } from '../errors.ts';

export function registerCatalogRoutes(app: FastifyInstance, pool: Pool, production = false): void {
  const emptyQuery = { type: 'object', additionalProperties: false } as const;
  const questionQuery = { type: 'object', additionalProperties: false, required: ['relationshipCode'], properties: { relationshipCode: { type: 'string', minLength: 1, maxLength: 40 } } } as const;
  app.get('/v1/relationship-types', { schema: { querystring: emptyQuery, response: { 200: relationshipTypeListSchema } } }, async () => ({ items: (await pool.query('SELECT code, label FROM relationship_types ORDER BY sort_order')).rows }));
  app.get<{ Querystring: { relationshipCode?: string } }>('/v1/questions', { schema: { querystring: questionQuery, response: { 200: questionCatalogSchema } } }, async (request) => {
    if (!request.query.relationshipCode) throw new HttpError(400, 'INVALID_INPUT', 'relationshipCode is required');
    const result = await pool.query('SELECT id, version, relationship_code AS "relationshipCode", prompt, is_custom_template AS "isCustomTemplate" FROM questions WHERE is_active AND (relationship_code = $1 OR is_custom_template) AND (SELECT count(*) FROM card_positions WHERE question_id = questions.id) = 3 ORDER BY is_custom_template, sort_order, id', [request.query.relationshipCode]);
    const ids = result.rows.map((row) => row.id);
    const positions = ids.length ? await pool.query('SELECT question_id AS "questionId", position, label, description FROM card_positions WHERE question_id = ANY($1::uuid[]) ORDER BY position', [ids]) : { rows: [] as Array<{ questionId: string }> };
    return { items: result.rows.map((question) => ({ ...question, positions: positions.rows.filter((position) => position.questionId === question.id).map(({ questionId: _ignored, ...position }) => position) })) };
  });
  app.get('/v1/cards', { schema: { querystring: emptyQuery, response: { 200: tarotCardCatalogSchema } } }, async () => ({ items: (await pool.query(`SELECT c.id, c.code, c.name, c.arcana, c.image_url AS "imageUrl" FROM tarot_cards c
      WHERE c.is_selectable AND EXISTS (
        SELECT 1 FROM interpretations i JOIN interpretation_versions v ON v.interpretation_id = i.id AND v.version = i.active_version
        WHERE i.tarot_card_id = c.id AND i.is_active AND i.locale = 'ko-KR' AND length(btrim(v.content, $2)) > 0
      ) AND (NOT $1::boolean OR NOT EXISTS (
        SELECT 1 FROM interpretations i JOIN interpretation_versions v ON v.interpretation_id = i.id AND v.version = i.active_version
        WHERE i.tarot_card_id = c.id AND i.is_active AND i.locale = 'ko-KR' AND v.source_kind = 'synthetic_test'
      )) ORDER BY c.code`, [production, SOURCE_WHITESPACE])).rows }));
}
