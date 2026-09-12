import assert from 'node:assert/strict';
import test from 'node:test';

import { formatWorkerEvent } from '../src/worker/log.ts';
import type { WorkerEvent } from '../src/worker/run.ts';

test('worker events are formatted as one JSON object per line', () => {
  const event: WorkerEvent = {
    event: 'reading_attempt_finished',
    readingId: 'reading-internal-id',
    attemptId: 'attempt-internal-id',
    attemptNo: 2,
    provider: 'fixture',
    model: 'fixture-v1',
    status: 'FAILED',
    durationMs: 125,
    errorCode: 'AI_RATE_LIMITED',
  };

  const line = formatWorkerEvent(event);

  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.deepEqual(JSON.parse(line), event);
});
