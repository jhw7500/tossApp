import type { FastifyError, FastifyInstance } from 'fastify';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(statusCode: number, code: string, message: string, retryable = false) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
  }
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => reply.status(404).send({ error: {
    code: 'NOT_FOUND', message: 'resource not found', retryable: false, requestId: request.id,
  } }));
  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    const send = (status: number, code: string, message: string, retryable = false) =>
      reply.status(status).send({ error: { code, message, retryable, requestId: request.id } });
    if ('validation' in error && error.validation) return send(400, 'INVALID_INPUT', 'invalid request input');
    if (error instanceof HttpError) return send(error.statusCode, error.code, error.message, error.retryable);
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return error.statusCode === 413
        ? send(413, 'REQUEST_TOO_LARGE', 'request is too large')
        : send(error.statusCode, 'INVALID_INPUT', 'invalid request input');
    }
    return send(500, 'INTERNAL_ERROR', 'internal server error');
  });
}
