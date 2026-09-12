import { readFile } from 'node:fs/promises';

const role = process.argv[2];
if (!['api', 'worker', 'migrate', 'seed'].includes(role)) throw new Error('Unknown server role');

const secret = async (name) => {
  const value = (await readFile(`/run/secrets/${name}`, 'utf8')).trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

process.env.DATABASE_URL = `postgresql://tarororo:${encodeURIComponent(await secret('db-password'))}@db:5432/tarororo_test`;
if (role === 'worker') {
  process.env.GEMINI_API_KEY = await secret('gemini-api-key');
  console.info(JSON.stringify({ event: 'worker_started' }));
  await import('/app/server/src/worker/main.ts');
} else if (role === 'api') {
  if (process.env.APP_ENV !== 'test' || process.env.AUTH_MODE !== 'toss') {
    throw new Error('PC test API requires APP_ENV=test and AUTH_MODE=toss');
  }
  process.env.AUTH_SUBJECT_SECRET = await secret('subject-secret');
  await import('/app/server/src/main.ts');
} else {
  if (process.env.APP_ENV !== 'test') throw new Error('Database commands require APP_ENV=test');
  const { createPool, createMigrationPool } = await import('/app/server/src/db/pool.ts');
  const pool = role === 'migrate' ? createMigrationPool(process.env.DATABASE_URL) : createPool(process.env.DATABASE_URL);
  try {
    if (role === 'migrate') {
      const { migrate } = await import('/app/server/src/db/migrate.ts');
      await migrate(pool);
    } else {
      const { seedDevelopment } = await import('/app/server/src/db/seed.ts');
      await seedDevelopment(pool);
    }
    console.info(JSON.stringify({ event: `${role}_completed` }));
  } finally { await pool.end(); }
}
