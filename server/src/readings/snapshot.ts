import type { PoolClient } from 'pg';
import { HttpError } from '../errors.ts';
import { MAX_CANDIDATES_PER_CARD, MAX_CONTEXT_BYTES, SOURCE_WHITESPACE } from './constants.ts';
import type { CreateReadingBody, ReadingContext, ReadingSnapshot } from './types.ts';

export function toReadingContext(snapshot: ReadingSnapshot): ReadingContext {
  return {
    relationshipCode: snapshot.person.relationshipCode,
    currentSituation: snapshot.person.currentSituation,
    question: snapshot.question,
    cards: snapshot.cards,
  };
}

export async function buildReadingSnapshot(client: PoolClient, userId: string, body: CreateReadingBody, production: boolean): Promise<ReadingSnapshot> {
  // These locks prevent Person edits and question/position version changes until commit.
  const persons = await client.query('SELECT * FROM persons WHERE id = $1 AND user_id = $2 FOR SHARE', [body.personId, userId]);
  if (!persons.rowCount) throw new HttpError(404, 'NOT_FOUND', 'person not found');
  const person = persons.rows[0];
  if (person.version !== body.personVersion) throw new HttpError(409, 'STALE_VERSION', 'person has changed');
  const questions = await client.query('SELECT * FROM questions WHERE id = $1 FOR SHARE', [body.question.id]);
  const question = questions.rows[0];
  if (!question) throw new HttpError(422, 'CONTENT_UNAVAILABLE', 'question is unavailable');
  if (question.version !== body.question.version) throw new HttpError(409, 'STALE_VERSION', 'question has changed');
  if (!question.is_active || (!question.is_custom_template && question.relationship_code !== person.relationship_code)) {
    throw new HttpError(422, 'CONTENT_UNAVAILABLE', 'question is unavailable');
  }
  if (question.is_custom_template ? !body.question.customText : body.question.customText !== undefined) {
    throw new HttpError(400, 'INVALID_INPUT', 'customText is required only for custom templates');
  }
  // One SQL statement gives positions, card metadata, and every active source a single MVCC view.
  const content = await client.query<{ positions: Array<{ position: number; label: string; description: string | null }>; cards: Array<ReadingSnapshot['cards'][number]> }>(`
    SELECT
      (SELECT coalesce(jsonb_agg(jsonb_build_object('position', position, 'label', label, 'description', description) ORDER BY position), '[]')
       FROM card_positions WHERE question_id = $1) AS positions,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'cardId', c.id, 'code', c.code, 'name', c.name, 'arcana', c.arcana, 'imageUrl', c.image_url,
        'candidates', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'interpretationId', i.id, 'version', v.version, 'text', v.content,
          'sourceKind', v.source_kind, 'sourceAttribution', v.source_attribution
        ) ORDER BY i.id), '[]') FROM interpretations i
          JOIN interpretation_versions v ON v.interpretation_id = i.id AND v.version = i.active_version
          WHERE i.tarot_card_id = c.id AND i.is_active AND i.locale = 'ko-KR' AND length(btrim(v.content, $3)) > 0)
      ) ORDER BY c.id), '[]') FROM tarot_cards c WHERE c.id = ANY($2::uuid[]) AND c.is_selectable) AS cards
  `, [question.id, body.selections.map(selection => selection.cardId), SOURCE_WHITESPACE]);
  const { positions, cards } = content.rows[0];
  if (positions.length !== 3 || cards.length !== 3 || cards.some(card => card.candidates.length === 0)) {
    throw new HttpError(422, 'CONTENT_UNAVAILABLE', 'three positions and readable cards are required');
  }
  if (cards.some(card => card.candidates.length > MAX_CANDIDATES_PER_CARD)) {
    throw new HttpError(422, 'CONTENT_CONTEXT_LIMIT', 'too many source candidates');
  }
  const testContent = cards.some(card => card.candidates.some(candidate => candidate.sourceKind === 'synthetic_test'));
  if (production && testContent) throw new HttpError(422, 'CONTENT_UNAVAILABLE', 'test content is unavailable in production');
  const snapshot: ReadingSnapshot = {
    person: { id: person.id, version: person.version, nickname: person.nickname, relationshipCode: person.relationship_code, currentSituation: person.current_situation },
    question: { id: question.id, version: question.version, text: body.question.customText ?? question.prompt, isCustom: question.is_custom_template },
    cards: body.selections.map(selection => {
      const card = cards.find(item => item.cardId === selection.cardId)!;
      const position = positions.find(item => item.position === selection.positionIndex)!;
      return { ...card, positionIndex: selection.positionIndex, label: position.label, description: position.description };
    }),
    testContent,
  };
  if (Buffer.byteLength(JSON.stringify(toReadingContext(snapshot)), 'utf8') > MAX_CONTEXT_BYTES) {
    throw new HttpError(422, 'CONTENT_CONTEXT_LIMIT', 'source context is too large');
  }
  return snapshot;
}
