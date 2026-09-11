import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const children = new Set();
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
  }
  const deadline = setTimeout(() => {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
  }, 8000);
  deadline.unref();
}

process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());

function start(label, args, cwd, env) {
  if (stopping) throw new Error('개발 서버 시작이 취소되었습니다.');
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', detached: true });
  children.add(child);
  child.once('error', () => {
    children.delete(child);
    console.error(`${label} 실행 실패`);
    stop(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} 종료 (${signal ?? code}). 함께 실행한 개발 프로세스를 정리합니다.`);
      stop(1);
    }
  });
}

function port(value, fallback) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < 1024 || result > 65535) {
    throw new Error('개발 포트는 1024~65535 정수여야 합니다.');
  }
  return result;
}

async function checkPort(host, portNumber) {
  await new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', () => reject(new Error(`${host}:${portNumber} 포트를 사용할 수 없습니다. 기존 프로세스를 확인하거나 TARORORO_WEB_PORT / TARORORO_API_PORT를 변경하세요.`)));
    socket.listen(portNumber, host, () => socket.close(resolve));
  });
}

async function waitReady(url) {
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Wait for the child to start listening. */ }
    await delay(250);
  }
  throw new Error('개발 서버가 준비되지 않았습니다. 위 실행 로그를 확인하세요.');
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 12)) throw new Error('Node 24.12 이상이 필요합니다. nvm use 후 다시 실행하세요.');
  try { loadEnvFile(resolve(root, 'server/.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('server/.env 파일을 읽을 수 없습니다.'); }

  const { readConfig } = await import('../server/src/config.ts');
  const { readAiConfig } = await import('../server/src/ai/config.ts');
  const config = readConfig();
  readAiConfig();
  if (config.environment !== 'local' || config.authMode !== 'mock') {
    throw new Error('이 명령은 APP_ENV=local, AUTH_MODE=mock 개발 환경 전용입니다.');
  }
  try {
    await access(resolve(root, 'ai-tarot/node_modules/vite/bin/vite.js'));
    await access(resolve(root, 'server/node_modules/pg/package.json'));
  } catch { throw new Error('ai-tarot/ 및 server/에서 npm ci를 먼저 실행하세요.'); }

  const apiPort = port(process.env.TARORORO_API_PORT, 3100);
  const webPort = port(process.env.TARORORO_WEB_PORT, 5173);
  const webHost = process.env.TARORORO_DEV_HOST || '0.0.0.0';
  if (apiPort === webPort) throw new Error('API와 화면의 포트는 달라야 합니다.');
  await checkPort('127.0.0.1', apiPort);
  await checkPort(webHost, webPort);

  const { Pool } = createRequire(resolve(root, 'server/package.json'))('pg');
  const pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    const { rows } = await pool.query("SELECT (SELECT count(*) FROM schema_migrations)::int AS migrations, (SELECT count(*) FROM questions)::int AS questions, (SELECT count(*) FROM tarot_cards)::int AS cards");
    if (rows[0].migrations < 3 || !rows[0].questions || rows[0].cards < 3) throw new Error();
  } catch { throw new Error('개발 DB와 초기 콘텐츠를 확인하세요. server/의 db:migrate, db:seed 설정은 server/README.md에 있습니다.'); }
  finally { await pool.end(); }

  const addresses = [...new Set(Object.values(networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal).map(item => item.address))];
  const hosts = webHost === '0.0.0.0' ? ['localhost', '127.0.0.1', ...addresses] : [webHost];
  const origins = hosts.map(host => `http://${host}:${webPort}`);
  const serverEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort), ALLOWED_ORIGINS: origins.join(',') };
  const frontendEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(frontendEnv, { VITE_API_BASE_URL: '', VITE_LOCAL_MOCK_AUTH: 'true', TARORORO_API_PORT: String(apiPort) });

  start('API', ['--watch', '--watch-preserve-output', '--experimental-strip-types', 'src/main.ts'], resolve(root, 'server'), serverEnv);
  await waitReady(`http://127.0.0.1:${apiPort}/health/ready`);
  start('Gemini worker', ['--watch', '--watch-preserve-output', '--experimental-strip-types', 'src/worker/main.ts'], resolve(root, 'server'), serverEnv);
  start('Vite', ['node_modules/vite/bin/vite.js', '--host', webHost, '--port', String(webPort), '--strictPort'], resolve(root, 'ai-tarot'), frontendEnv);
  await waitReady(`${origins[0]}/api/health/ready`);
  console.log('\nTarororo 개발 환경 준비 완료 (브라우저 식별 mock / 실제 DB + Gemini)');
  console.log(`  ${origins[0]}/`);
  console.log('폰: 위 Network 주소 중 같은 Wi-Fi의 192.168.x.x 주소로 여세요.');
  console.log('주의: 현재 TDS는 Tailscale의 100.x 주소를 허용하지 않습니다.');
  console.log('화면 저장 시 HMR, 서버 저장 시 자동 재시작.');
  console.log('종료: Ctrl+C (이 명령으로 실행한 프로세스만 종료, DB 보존)\n');
} catch (error) {
  console.error(error.message);
  stop(1);
}
