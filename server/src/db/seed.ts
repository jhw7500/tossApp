import type { Pool } from 'pg';
import { pathToFileURL } from 'node:url';

const ids = {
  crush: '10000000-0000-4000-8000-000000000001', friendship: '10000000-0000-4000-8000-000000000002', custom: '10000000-0000-4000-8000-000000000003', relationship: '10000000-0000-4000-8000-000000000004', family: '10000000-0000-4000-8000-000000000005',
  fool: '20000000-0000-4000-8000-000000000001', lovers: '20000000-0000-4000-8000-000000000002', star: '20000000-0000-4000-8000-000000000003',
};

const positionIds: Record<string, readonly string[]> = {
  [ids.crush]: ['10000000-0000-4000-8000-000000000110', '10000000-0000-4000-8000-000000000120', '10000000-0000-4000-8000-000000000130'],
  [ids.friendship]: ['10000000-0000-4000-8000-000000000210', '10000000-0000-4000-8000-000000000220', '10000000-0000-4000-8000-000000000230'],
  [ids.custom]: ['10000000-0000-4000-8000-000000000310', '10000000-0000-4000-8000-000000000320', '10000000-0000-4000-8000-000000000330'],
  [ids.relationship]: ['10000000-0000-4000-8000-000000000410', '10000000-0000-4000-8000-000000000420', '10000000-0000-4000-8000-000000000430'],
  [ids.family]: ['10000000-0000-4000-8000-000000000510', '10000000-0000-4000-8000-000000000520', '10000000-0000-4000-8000-000000000530'],
};

export async function seedDevelopment(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO relationship_types (code, label, sort_order) VALUES ('crush', '썸', 1), ('relationship', '연인', 2), ('friendship', '친구', 3), ('family', '가족', 4), ('custom', '직접 입력', 5) ON CONFLICT (code) DO NOTHING");
    const questions = [[ids.crush, 'crush', '그 사람과의 가능성이 궁금해요', false, 1], [ids.relationship, 'relationship', '우리 관계의 흐름이 궁금해요', false, 1], [ids.friendship, 'friendship', '우리 우정의 흐름이 궁금해요', false, 1], [ids.family, 'family', '가족과의 관계가 궁금해요', false, 1], [ids.custom, 'custom', '직접 질문을 입력하세요', true, 1]];
    for (const row of questions) await client.query('INSERT INTO questions (id, relationship_code, prompt, is_custom_template, sort_order) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING', row);
    for (const question of questions) for (const [position, label] of [[1, '현재'], [2, '상대의 마음'], [3, '조언']] as const) {
      const questionId = question[0] as string;
      await client.query('INSERT INTO card_positions (id, question_id, position, label) VALUES ($1, $2, $3, $4) ON CONFLICT (question_id, position) DO NOTHING', [positionIds[questionId][position - 1], questionId, position, label]);
    }
    const cards = [[ids.fool, 'the-fool', '바보', 'major'], [ids.lovers, 'the-lovers', '연인', 'major'], [ids.star, 'the-star', '별', 'major']];
    for (const card of cards) await client.query('INSERT INTO tarot_cards (id, code, name, arcana) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', card);
    for (const card of cards) {
      const suffix = cards.indexOf(card) + 1;
      const interpretationIds = [`30000000-0000-4000-8000-00000000000${suffix}`, `31000000-0000-4000-8000-00000000000${suffix}`, `32000000-0000-4000-8000-00000000000${suffix}`];
      for (const [candidateIndex, interpretationId] of interpretationIds.entries()) {
        const inserted = await client.query('INSERT INTO interpretations (id, tarot_card_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id', [interpretationId, card[0]]);
        const versions = candidateIndex === 0 ? [1, 2, 3] : [1];
        for (const version of versions) {
          const versionId = candidateIndex === 0 ? `${interpretationId.slice(0, -3)}${suffix}${version}0` : `${interpretationId.slice(0, -3)}${suffix}${candidateIndex + 1}${version}`;
          await client.query('INSERT INTO interpretation_versions (id, interpretation_id, version, content, source_kind, source_attribution) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (interpretation_id, version) DO NOTHING', [versionId, interpretationId, version, `시험용 ${card[2]} 해석 후보 ${candidateIndex + 1}`, 'synthetic_test', 'synthetic test fixture']);
        }
        if (inserted.rowCount) {
          await client.query('UPDATE interpretations SET active_version = $1 WHERE id = $2', [versions.at(-1), interpretationId]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readConfig } = await import('../config.ts');
  const config = readConfig();
  if (config.environment === 'production') throw new Error('seeding is disabled in production');
  const { createPool } = await import('./pool.ts'); const pool = createPool(config.databaseUrl);
  try { await seedDevelopment(pool); } finally { await pool.end(); }
}
