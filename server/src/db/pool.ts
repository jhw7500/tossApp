import { Pool } from 'pg';

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export function createMigrationPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
}
