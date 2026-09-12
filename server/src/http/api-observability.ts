export interface ApiRequestEvent {
  event: 'api_request_finished';
  requestId: string;
  statusCode: number;
  durationMs: number;
  errorCode: string | null;
}

export type ApiLogEvent = ApiRequestEvent | {
  event: 'api_listening';
  host: string;
  port: number;
} | {
  event: 'api_shutting_down';
  signal: 'SIGINT' | 'SIGTERM';
};

export type ApiEventObserver = (event: ApiRequestEvent) => void | Promise<void>;

export function emitApiEvent(observer: ApiEventObserver | undefined, event: ApiRequestEvent): void {
  try {
    const pending = observer?.(event);
    if (pending) void pending.catch(() => undefined);
  } catch {
    // Observability must never change request processing or responses.
  }
}

export function normalizeApiErrorCode(code: unknown): string {
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'INTERNAL_ERROR';
}

export function formatApiEvent(event: ApiLogEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function createApiEventWriter(writeLine: (line: string) => void | Promise<void>): (event: ApiLogEvent) => void {
  return event => {
    try {
      const pending = writeLine(formatApiEvent(event));
      if (pending) void pending.catch(() => undefined);
    } catch {
      // Runtime lifecycle logging must not block startup or shutdown.
    }
  };
}
