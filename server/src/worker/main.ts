import { GeminiProvider } from '../ai/gemini.ts';
import { readWorkerConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { runWorker } from './run.ts';

const { databaseUrl, ai } = readWorkerConfig();
const pool = createPool(databaseUrl);
const controller = new AbortController();
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  controller.abort();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await runWorker({ pool, provider: new GeminiProvider({ apiKey: ai.apiKey, model: ai.model }), signal: controller.signal });
} finally {
  await pool.end();
}
