import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { anonymousSessionBodySchema } from '../../contracts/foundation.schemas.ts';
import { createSession, revokeSession, sessionUserId } from './auth/sessions.ts';
import { verifyTossAnonymousKey as verifyToss } from './auth/toss-client.ts';
import type { FoundationConfig } from './config.ts';
import { installErrorHandler, HttpError } from './errors.ts';
import { emitApiEvent, type ApiEventObserver } from './http/api-observability.ts';
import { registerCatalogRoutes } from './routes/catalogs.ts';
import { registerReadingRoutes } from './routes/readings.ts';
import { registerPersonRoutes } from './routes/persons.ts';

export type VerifyAnonymousKey = (key: string) => Promise<boolean>;

declare module 'fastify' { interface FastifyRequest { userId?: string; sessionToken?: string; apiErrorCode?: string; } }

const noQuerySchema = { type: 'object', additionalProperties: false } as const;

export async function buildApp(options: { config: FoundationConfig; pool: Pool; verifyAnonymousKey?: VerifyAnonymousKey; onEvent?: ApiEventObserver }): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger: false,
    return503OnClosing: false,
    ajv: { customOptions: { removeAdditional: false, allErrors: true } },
  });
  await app.register(cors, { origin: options.config.allowedOrigins, methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], credentials: false });
  installErrorHandler(app);
  const attempts = new Map<string, { count: number; startedAt: number }>();
  const verify = options.verifyAnonymousKey ?? (options.config.authMode === 'mock' ? async (key: string) => key.length > 0 : async (key: string) => verifyToss(key, { certPath: options.config.tossCertPath!, keyPath: options.config.tossKeyPath! }));
  app.post<{ Body: { anonymousKey: string } }>('/v1/sessions/toss-anonymous', { schema: { body: anonymousSessionBodySchema, querystring: noQuerySchema } }, async (request, reply) => {
    const ip = request.ip; const now = Date.now();
    for (const [peer, attempt] of attempts) if (now - attempt.startedAt > 60_000) attempts.delete(peer);
    if (attempts.size >= 1024 && !attempts.has(ip)) attempts.delete(attempts.keys().next().value!);
    const rate = attempts.get(ip); if (!rate) attempts.set(ip, { count: 1, startedAt: now }); else { rate.count += 1; if (rate.count > 10) throw new HttpError(429, 'RATE_LIMITED', 'too many authentication attempts'); }
    let valid: boolean; try { valid = await verify(request.body.anonymousKey); } catch { throw new HttpError(503, 'AUTH_UNAVAILABLE', 'anonymous key verification is unavailable'); }
    if (!valid) throw new HttpError(401, 'UNAUTHORIZED', 'anonymous key is invalid');
    return reply.status(201).send(await createSession(options.pool, options.config, request.body.anonymousKey));
  });
  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.url === '/v1/sessions/toss-anonymous' || request.routeOptions.url === '/health/ready') return;
    const authorization = request.headers.authorization; const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'valid session required'); const userId = await sessionUserId(options.pool, token); if (!userId) throw new HttpError(401, 'UNAUTHORIZED', 'valid session required'); request.userId = userId; request.sessionToken = token;
  });
  app.delete('/v1/sessions/current', { schema: { querystring: noQuerySchema } }, async (request, reply) => { await revokeSession(options.pool, request.sessionToken!); return reply.status(204).send(); });
  registerPersonRoutes(app, options.pool); registerCatalogRoutes(app, options.pool, options.config.environment === 'production');
  registerReadingRoutes(app, options.pool, options.config.environment === 'production');
  app.get('/health/ready', { schema: { querystring: noQuerySchema } }, async (request, reply) => {
    try {
      await options.pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      request.apiErrorCode = 'SERVICE_UNAVAILABLE';
      return reply.status(503).send({ status: 'unavailable' });
    }
  });
  app.addHook('onResponse', (request, reply, done) => {
    emitApiEvent(options.onEvent, {
      event: 'api_request_finished',
      requestId: request.id,
      statusCode: reply.statusCode,
      durationMs: Math.max(0, reply.elapsedTime),
      errorCode: request.apiErrorCode ?? null,
    });
    done();
  });
  return app;
}
