import { buildApp } from './app.ts';
import { readConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { createApiEventWriter } from './http/api-observability.ts';

const config = readConfig(); const pool = createPool(config.databaseUrl);
const writeEvent = createApiEventWriter(line => { process.stdout.write(line); });
const app = await buildApp({
  config,
  pool,
  onEvent: writeEvent,
});
app.addHook('onClose', async () => { await pool.end(); });
await app.listen({ host: config.host, port: config.port });
writeEvent({ event: 'api_listening', host: config.host, port: config.port });
let closing = false;
const close = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
  if (closing) return;
  closing = true;
  writeEvent({ event: 'api_shutting_down', signal });
  await app.close();
};
process.once('SIGINT', () => { void close('SIGINT'); });
process.once('SIGTERM', () => { void close('SIGTERM'); });
