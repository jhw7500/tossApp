import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { createEmptyIsolatedPool, createIsolatedPool } from './helpers.ts';
import { migrate } from '../src/db/migrate.ts';
import { seedDevelopment } from '../src/db/seed.ts';

test('migration and seed are repeatable and preserve versioned sample content', async () => {
  const { pool, dispose } = await createIsolatedPool();
  try {
    await migrate(pool);
    await seedDevelopment(pool);
    const questions = await pool.query('SELECT id FROM questions');
    const positions = await pool.query('SELECT question_id, position FROM card_positions');
    const cards = await pool.query('SELECT id FROM tarot_cards');
    const versions = await pool.query('SELECT iv.id FROM interpretation_versions iv');
    assert.ok(questions.rowCount && questions.rowCount >= 2);
    assert.equal(positions.rowCount, questions.rowCount! * 3);
    assert.equal(cards.rowCount, 3);
    assert.equal(versions.rowCount, 15);
    const candidates = await pool.query('SELECT count(*)::integer AS count FROM interpretations');
    assert.equal(candidates.rows[0].count, 9);
  } finally { await dispose(); }
});

test('database foreign keys and unique constraints are enforced', async () => {
  const { pool, dispose } = await createIsolatedPool();
  try {
    await assert.rejects(() => pool.query("INSERT INTO card_positions (id, question_id, position, label) VALUES ($1, '00000000-0000-0000-0000-000000000000', 1, 'x')", [randomUUID()]), (error: { code?: string }) => error.code === '23503');
    const question = await pool.query('SELECT id FROM questions LIMIT 1');
    await assert.rejects(() => pool.query('INSERT INTO card_positions (id, question_id, position, label) VALUES ($1, $2, 1, $3)', [randomUUID(), question.rows[0].id, 'duplicate']), (error: { code?: string }) => error.code === '23505');
  } finally { await dispose(); }
});

test('legacy seed upgrades without changing position IDs and gains three independent candidates per card', async () => {
  const { pool, dispose } = await createEmptyIsolatedPool();
  try {
    const migration = await readFile(resolve(import.meta.dirname, '../migrations/001_foundation.sql'), 'utf8');
    await pool.query(migration);
    await pool.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', ['001_foundation.sql', createHash('sha256').update(migration).digest('hex')]);
    await pool.query("INSERT INTO relationship_types (code, label, sort_order) VALUES ('crush', '썸', 1), ('relationship', '연인', 2), ('friendship', '친구', 3), ('family', '가족', 4), ('custom', '직접 입력', 5)");
    await pool.query("INSERT INTO questions (id, relationship_code, prompt, is_custom_template, sort_order) VALUES ('10000000-0000-4000-8000-000000000001', 'crush', 'legacy crush', false, 1), ('10000000-0000-4000-8000-000000000002', 'friendship', 'legacy friendship', false, 1), ('10000000-0000-4000-8000-000000000003', 'custom', 'legacy custom', true, 1)");
    await pool.query("INSERT INTO card_positions (id, question_id, position, label) VALUES ('10000000-0000-4000-8000-000000000110', '10000000-0000-4000-8000-000000000001', 1, '현재'), ('10000000-0000-4000-8000-000000000210', '10000000-0000-4000-8000-000000000002', 1, '현재'), ('10000000-0000-4000-8000-000000000310', '10000000-0000-4000-8000-000000000003', 1, '현재')");
    await pool.query("INSERT INTO tarot_cards (id, code, name, arcana) VALUES ('20000000-0000-4000-8000-000000000001', 'the-fool', '바보', 'major'), ('20000000-0000-4000-8000-000000000002', 'the-lovers', '연인', 'major'), ('20000000-0000-4000-8000-000000000003', 'the-star', '별', 'major')");
    await pool.query("INSERT INTO interpretations (id, tarot_card_id) VALUES ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001'), ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002'), ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003')");
    await pool.query("INSERT INTO interpretation_versions (id, interpretation_id, version, content, source_kind, source_attribution) VALUES ('30000000-0000-4000-8000-000000000110', '30000000-0000-4000-8000-000000000001', 1, 'legacy', 'synthetic_test', 'legacy fixture')");
    await migrate(pool); await seedDevelopment(pool); await migrate(pool); await seedDevelopment(pool);
    assert.equal((await pool.query("SELECT id FROM card_positions WHERE id = '10000000-0000-4000-8000-000000000210'")).rowCount, 1);
    const candidates = await pool.query('SELECT tarot_card_id, count(DISTINCT id)::integer AS count FROM interpretations WHERE locale = $1 GROUP BY tarot_card_id', ['ko-KR']);
    assert.equal(candidates.rowCount, 3); assert.ok(candidates.rows.every((row) => row.count === 3));
    const legacyVersions = await pool.query("SELECT count(*)::integer AS count FROM interpretation_versions WHERE interpretation_id = '30000000-0000-4000-8000-000000000001'");
    assert.equal(legacyVersions.rows[0].count, 3);
  } finally { await dispose(); }
});
