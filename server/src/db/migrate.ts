import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Pool } from 'pg';

const migrationNames = ['001_foundation.sql', '002_interpretation_candidates.sql', '003_reading_flow.sql'];

export async function migrate(pool: Pool): Promise<void> {
  const migrations = await Promise.all(migrationNames.map(async (name) => ({ name, sql: await readFile(resolve(import.meta.dirname, '../../migrations', name), 'utf8') })));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tarororo_foundation_migrations'))");
    const historyExists = await client.query("SELECT to_regclass('schema_migrations') AS name");
    const applied = new Map<string, string>();
    if (historyExists.rows[0].name) {
      for (const row of (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows) applied.set(row.name, row.checksum);
    }
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const existing = applied.get(migration.name);
      if (existing) {
        if (existing !== checksum) throw new Error(`migration checksum mismatch: ${migration.name}`);
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readConfig } = await import('../config.ts');
  const { createPool } = await import('./pool.ts');
  const pool = createPool(readConfig().databaseUrl);
  try { await migrate(pool); } finally { await pool.end(); }
}
