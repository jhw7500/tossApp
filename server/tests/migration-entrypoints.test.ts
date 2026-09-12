import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const poolUrl = new URL('../src/db/pool.ts', import.meta.url).href;
const configUrl = new URL('../src/config.ts', import.meta.url).href;
const migrateUrl = new URL('../src/db/migrate.ts', import.meta.url).href;
const runnerUrl = new URL('../../deploy/pc-test/run.mjs', import.meta.url).href;

// Run the real entrypoints and pool factory, replacing only external boundaries.
// No environment files, credentials, sockets, services or database are accessed.
function run(role: string, appEnv = 'test', failMigration = false) {
  const direct = role === 'direct-migrate';
  const script = `
    import { registerHooks } from 'node:module';
    import { fileURLToPath } from 'node:url';
    globalThis.events = [];
    const record = source => 'data:text/javascript,' + encodeURIComponent(source);
    const stubs = {
      'pg': record(\`
        export class Pool {
          constructor(options) { this.options = options; events.push(['pool', options.connectionTimeoutMillis ?? null]); }
          async connect() {
            events.push(['connect']);
            return {
              async query() { return { rows: [{ name: null }] }; },
              release() { events.push(['release']); }
            };
          }
          async end() { events.push(['end']); }
        }
      \`),
      'node:fs/promises': record(\`
        export async function readFile(path) {
          if (String(path).startsWith('/run/secrets/')) {
            events.push(['secret', String(path).slice('/run/secrets/'.length)]);
            return 'synthetic-fixture-only';
          }
          if (${direct} && String(path).endsWith('.sql')) return 'SELECT 1;';
          throw new Error('Unexpected file access');
        }
      \`),
      ${JSON.stringify(configUrl)}: record('export const readConfig = () => ({ databaseUrl: "postgresql://fixture:fixture@database.invalid/fixture" });'),
      '/app/server/src/db/migrate.ts': record('export async function migrate() { events.push(["migrate"]); ${failMigration ? 'throw new Error("synthetic migration failure");' : ''} }'),
      '/app/server/src/db/seed.ts': record('export async function seedDevelopment() { events.push(["seed"]); }'),
      '/app/server/src/main.ts': record('events.push(["api"]);'),
      '/app/server/src/worker/main.ts': record('events.push(["worker"]);'),
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '/app/server/src/db/pool.ts') return { url: ${JSON.stringify(poolUrl)}, shortCircuit: true };
        if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true };
        const resolved = nextResolve(specifier, context);
        if (stubs[resolved.url]) return { url: stubs[resolved.url], shortCircuit: true };
        return resolved;
      }
    });
    process.argv = [process.execPath, fileURLToPath(${JSON.stringify(direct ? migrateUrl : runnerUrl)}), ${JSON.stringify(role)}];
    console.info = () => {};
    let error = null;
    try { await import(${JSON.stringify(direct ? migrateUrl : runnerUrl)}); }
    catch (failure) { error = failure.message; }
    console.log(JSON.stringify({ events, error }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: process.env.PATH, APP_ENV: appEnv, AUTH_MODE: 'toss' },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  return JSON.parse(child.stdout) as { events: (string | number | null)[][]; error: string | null };
}

test('PC migration selects the bounded pool and ends it on success', () => {
  assert.deepEqual(run('migrate'), {
    events: [['secret', 'db-password'], ['pool', 5_000], ['migrate'], ['end']], error: null,
  });
});

test('PC migration failure still ends its bounded pool', () => {
  assert.deepEqual(run('migrate', 'test', true), {
    events: [['secret', 'db-password'], ['pool', 5_000], ['migrate'], ['end']], error: 'synthetic migration failure',
  });
});

test('direct migration CLI selects the same bounded pool', () => {
  assert.deepEqual(run('direct-migrate'), {
    events: [['pool', 5_000], ['connect'], ['release'], ['end']], error: null,
  });
});

test('PC seed keeps its ordinary pool and existing role', () => {
  assert.deepEqual(run('seed'), {
    events: [['secret', 'db-password'], ['pool', null], ['seed'], ['end']], error: null,
  });
});

test('API and worker keep their existing entrypoints and secret boundaries', () => {
  assert.deepEqual(run('api'), {
    events: [['secret', 'db-password'], ['secret', 'subject-secret'], ['api']], error: null,
  });
  assert.deepEqual(run('worker'), {
    events: [['secret', 'db-password'], ['secret', 'gemini-api-key'], ['worker']], error: null,
  });
});

test('PC migration refuses a non-test environment before constructing a pool', () => {
  assert.deepEqual(run('migrate', 'production'), {
    events: [['secret', 'db-password']], error: 'Database commands require APP_ENV=test',
  });
});
