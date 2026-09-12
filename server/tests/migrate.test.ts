import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import type { Pool } from 'pg';

import { migrate } from '../src/db/migrate.ts';

const migrationNames = ['001_foundation.sql', '002_interpretation_candidates.sql', '003_reading_flow.sql', '004_subject_identity_rotation.sql'];
const lockQuery = "SELECT pg_advisory_xact_lock(hashtext('tarororo_foundation_migrations'))";
const historyCheckQuery = "SELECT to_regclass('schema_migrations') AS name";
const historyInsertQuery = 'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)';

type QueryCall = { text: string; values?: readonly unknown[] };

function createFakePool(options: {
  connectError?: Error;
  failOn?: string;
  queryError?: Error;
  rollbackError?: Error;
} = {}) {
  const calls: QueryCall[] = [];
  const releases: Array<Error | boolean | undefined> = [];
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      if (text === 'ROLLBACK' && options.rollbackError) throw options.rollbackError;
      if (text === options.failOn) throw options.queryError;
      if (text === historyCheckQuery) return { rows: [{ name: null }] };
      return { rows: [], rowCount: 0 };
    },
    release: (destroy?: Error | boolean) => { releases.push(destroy); },
  };
  const pool = {
    connect: async () => {
      if (options.connectError) throw options.connectError;
      return client;
    },
  } as unknown as Pool;
  return { pool, calls, releases };
}

async function readMigrations() {
  return Promise.all(migrationNames.map(async (name) => ({
    name,
    sql: await readFile(resolve(import.meta.dirname, '../migrations', name), 'utf8'),
  })));
}

test('applies migrations in order and records each history row before commit', async () => {
  const migrations = await readMigrations();
  const { pool, calls, releases } = createFakePool();

  await migrate(pool);

  assert.deepEqual(calls, [
    { text: 'BEGIN', values: undefined },
    { text: lockQuery, values: undefined },
    { text: historyCheckQuery, values: undefined },
    ...migrations.flatMap(({ name, sql }) => [
      { text: sql, values: undefined },
      { text: historyInsertQuery, values: [name, createHash('sha256').update(sql).digest('hex')] },
    ]),
    { text: 'COMMIT', values: undefined },
  ]);
  assert.deepEqual(releases, [undefined]);
});

test('a failed migration stops later SQL, rolls back, and rethrows the original error', async () => {
  const migrations = await readMigrations();
  const queryError = new Error('migration query failed');
  const { pool, calls, releases } = createFakePool({ failOn: migrations[1].sql, queryError });

  await assert.rejects(migrate(pool), (error) => error === queryError);

  assert.equal(calls.some(({ text }) => text === migrations[2].sql), false);
  assert.equal(calls.at(-1)?.text, 'ROLLBACK');
  assert.deepEqual(releases, [undefined]);
});

test('a rollback failure preserves both errors and destroys the uncertain client', async () => {
  const migrations = await readMigrations();
  const queryError = new Error('migration query failed');
  const rollbackError = new Error('rollback failed');
  const { pool, releases } = createFakePool({ failOn: migrations[1].sql, queryError, rollbackError });

  await assert.rejects(migrate(pool), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'migration and rollback both failed');
    assert.deepEqual(error.errors, [queryError, rollbackError]);
    assert.equal(error.cause, queryError);
    return true;
  });
  assert.deepEqual(releases, [true]);
});

test('a connect failure does not release a client that was never acquired', async () => {
  const connectError = new Error('connect failed');
  const { pool, calls, releases } = createFakePool({ connectError });

  await assert.rejects(migrate(pool), (error) => error === connectError);

  assert.deepEqual(calls, []);
  assert.deepEqual(releases, []);
});
