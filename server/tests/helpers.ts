import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { migrate } from '../src/db/migrate.ts';
import { seedDevelopment } from '../src/db/seed.ts';

export async function createIsolatedPool(): Promise<{ pool: Pool; dispose: () => Promise<void> }> {
  const fixture = await createEmptyIsolatedPool();
  await migrate(fixture.pool);
  await seedDevelopment(fixture.pool);
  return fixture;
}
export async function createEmptyIsolatedPool(): Promise<{ pool: Pool; dispose: () => Promise<void> }> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for integration tests');
  const schema = `tarororo_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  await admin.end();
  return {
    pool,
    async dispose() {
      await pool.end();
      const cleanup = new Pool({ connectionString: databaseUrl });
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await cleanup.end();
    },
  };
}

export const testConfig = {
  environment: 'test' as const,
  host: '127.0.0.1',
  port: 3100,
  databaseUrl: 'postgresql://test',
  authMode: 'mock' as const,
  subjectSecret: 'a'.repeat(32),
  subjectSecretVersion: 'v1',
  previousSubjectSecrets: [],
  allowedOrigins: ['http://localhost:3000'],
};

import { buildApp } from '../src/app.ts';

export async function readingFixture() {
  const fixture = await createIsolatedPool();
  const app = await buildApp({ config: testConfig, pool: fixture.pool });
  const session = await app.inject({ method: 'POST', url: '/v1/sessions/toss-anonymous', payload: { anonymousKey: randomUUID() } });
  const headers = { authorization: `Bearer ${session.json().token}` };
  const person = (await app.inject({ method: 'POST', url: '/v1/persons', headers, payload: { nickname: '민지', relationshipCode: 'crush', currentSituation: '대화가 줄었어요' } })).json();
  const questions = (await app.inject({ url: '/v1/questions?relationshipCode=crush', headers })).json().items;
  const question = questions.find((item: { isCustomTemplate: boolean }) => !item.isCustomTemplate);
  const cards = (await app.inject({ url: '/v1/cards', headers })).json().items;
  const body = { personId: person.id as string, personVersion: person.version as number, question: { id: question.id as string, version: (question.version ?? 1) as number }, selections: cards.map((card: { id: string }, index: number) => ({ cardId: card.id, positionIndex: index + 1 })) };
  return { ...fixture, app, headers, person, body, async close() { await app.close(); await fixture.dispose(); } };
}
