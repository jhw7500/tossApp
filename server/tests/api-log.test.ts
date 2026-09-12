import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiEventWriter, formatApiEvent, type ApiLogEvent, type ApiRequestEvent } from '../src/http/api-observability.ts';

test('API events are formatted as one JSON object per line', () => {
  const event: ApiRequestEvent = {
    event: 'api_request_finished',
    requestId: 'req-internal-id',
    statusCode: 503,
    durationMs: 12.5,
    errorCode: 'AUTH_UNAVAILABLE',
  };

  const line = formatApiEvent(event);

  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.deepEqual(JSON.parse(line), event);
});

test('API log writer emits bounded service lifecycle records and isolates write failures', async () => {
  const lines: string[] = [];
  const write = createApiEventWriter(line => { lines.push(line); });
  const events: ApiLogEvent[] = [
    { event: 'api_listening', host: '127.0.0.1', port: 3100 },
    { event: 'api_shutting_down', signal: 'SIGTERM' },
  ];

  for (const event of events) write(event);

  assert.deepEqual(lines.map(line => JSON.parse(line)), events);
  const failingWrite = createApiEventWriter(() => { throw new Error('stdout unavailable'); });
  assert.doesNotThrow(() => failingWrite(events[0]));
  const rejectingWrite = createApiEventWriter(async () => { throw new Error('async stdout unavailable'); });
  rejectingWrite(events[0]);
  await new Promise(resolve => setImmediate(resolve));
});
