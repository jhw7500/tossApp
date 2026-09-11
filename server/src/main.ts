import { buildApp } from './app.ts';
import { readConfig } from './config.ts';
import { createPool } from './db/pool.ts';

const config = readConfig(); const pool = createPool(config.databaseUrl);
const logger = { redact: { paths: ['req.headers.authorization', 'req.headers.x-anon-key', 'req.body.anonymousKey'], censor: '[REDACTED]' } };
const app = await buildApp({ config, pool, logger });
app.addHook('onClose', async () => { await pool.end(); });
await app.listen({ host: config.host, port: config.port });
app.log.info({ host: config.host, port: config.port }, 'Tarororo API listening');
let closing = false;
const close = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down Tarororo API');
  await app.close();
};
process.once('SIGINT', () => { void close('SIGINT'); });
process.once('SIGTERM', () => { void close('SIGTERM'); });
