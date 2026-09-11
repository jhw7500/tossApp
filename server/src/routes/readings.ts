import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createReadingBodySchema, retryReadingBodySchema, acceptedReadingSchema, readingDetailSchema, readingHistorySchema } from '../../../contracts/reading.schemas.ts';
import { createReading, getReading, listReadings, retryReading } from '../readings/store.ts';
import type { CreateReadingBody, RetryReadingBody } from '../readings/types.ts';

const noQuery = { type: 'object', additionalProperties: false } as const;
const idempotencyHeaders = {
  type: 'object', required: ['idempotency-key'],
  properties: { 'idempotency-key': { type: 'string', format: 'uuid' } },
} as const;
const readingParams = {
  type: 'object', additionalProperties: false, required: ['readingId'],
  properties: { readingId: { type: 'string', format: 'uuid' } },
} as const;

export function registerReadingRoutes(app: FastifyInstance, pool: Pool, production: boolean): void {
  app.post<{ Body: CreateReadingBody }>('/v1/readings', {
    schema: { body: createReadingBodySchema, querystring: noQuery, headers: idempotencyHeaders, response: { 200: acceptedReadingSchema, 202: acceptedReadingSchema } },
  }, async (request, reply) => {
    const accepted = await createReading(pool, request.userId!, String(request.headers['idempotency-key']).toLowerCase(), request.body, production);
    return reply.status(accepted.replayed ? 200 : 202).send(accepted.reading);
  });
  app.get<{ Params: { readingId: string } }>('/v1/readings/:readingId', {
    schema: { params: readingParams, querystring: noQuery, response: { 200: readingDetailSchema } },
  }, request => getReading(pool, request.userId!, request.params.readingId));
  app.post<{ Params: { readingId: string }; Body: RetryReadingBody }>('/v1/readings/:readingId/retry', {
    schema: { params: readingParams, body: retryReadingBodySchema, querystring: noQuery, headers: idempotencyHeaders, response: { 200: acceptedReadingSchema, 202: acceptedReadingSchema } },
  }, async (request, reply) => {
    const accepted = await retryReading(pool, request.userId!, request.params.readingId.toLowerCase(), String(request.headers['idempotency-key']).toLowerCase(), request.body);
    return reply.status(accepted.replayed ? 200 : 202).send(accepted.reading);
  });
  app.get<{ Params: { personId: string }; Querystring: { cursor?: string; limit?: string } }>('/v1/persons/:personId/readings', {
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['personId'], properties: { personId: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string' }, limit: { type: 'string' } } },
      response: { 200: readingHistorySchema },
    },
  }, request => listReadings(pool, request.userId!, request.params.personId, request.query));
}
