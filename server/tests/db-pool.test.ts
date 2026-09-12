import assert from 'node:assert/strict';
import test from 'node:test';

import * as pools from '../src/db/pool.ts';

test('migration pools bound connection acquisition without changing ordinary pools', async () => {
  const factory = (pools as typeof pools & { createMigrationPool?: typeof pools.createPool }).createMigrationPool;
  assert.equal(typeof factory, 'function', 'migration connections need their own bounded factory');
  const url = 'postgresql://fixture:fixture@database.invalid/fixture';
  const migration = factory!(url);
  const ordinary = pools.createPool(url);
  try {
    assert.equal(migration.options.connectionString, url);
    assert.equal(migration.options.connectionTimeoutMillis, 5_000);
    assert.equal(ordinary.options.connectionTimeoutMillis, undefined);
    assert.equal(migration.totalCount, 0, 'constructing a pool must not connect');
    assert.equal(ordinary.totalCount, 0);
  } finally {
    await Promise.all([migration.end(), ordinary.end()]);
  }
});
