import type { Pool } from 'pg';
import { contextForClaim } from '../ai/context.ts';
import { AiProviderError, type ReadingProvider } from '../ai/types.ts';
import { validateReadingResult } from '../ai/validate.ts';
import { claimNextReading, completeReading, expireReadings, failReading, normalizeFailureCode } from '../readings/attempts.ts';
import type { ReadingClaim, ReadingUsage } from '../readings/types.ts';

export type WorkerEvent = {
  event: 'reading_attempt_started';
  readingId: string;
  attemptId: string;
  attemptNo: number;
  provider: string;
  model: string;
} | {
  event: 'reading_attempt_finished';
  readingId: string;
  attemptId: string;
  attemptNo: number;
  provider: string;
  model: string;
  status: 'SUCCEEDED';
  durationMs: number;
  usage: import('../readings/types.ts').ReadingUsage | null;
} | {
  event: 'reading_attempt_finished';
  readingId: string;
  attemptId: string;
  attemptNo: number;
  provider: string;
  model: string;
  status: 'FAILED';
  durationMs: number;
  errorCode: string;
} | {
  event: 'reading_attempt_finished';
  readingId: string;
  attemptId: string;
  attemptNo: number;
  provider: string;
  model: string;
  status: 'STALE';
  durationMs: number;
};

export interface RunWorkerOptions {
  pool: Pool;
  provider: ReadingProvider;
  signal: AbortSignal;
  concurrency?: number;
  pollIntervalMs?: number;
  onEvent?: (event: WorkerEvent) => void | Promise<void>;
}

function emitWorkerEvent(onEvent: RunWorkerOptions['onEvent'], event: WorkerEvent): void {
  try {
    const pending = onEvent?.(event);
    if (pending) void pending.catch(() => undefined);
  } catch {
    // Observability must never change claim processing or retry behavior.
  }
}

function normalizeUsage(value: unknown): ReadingUsage | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const take = (name: keyof ReadingUsage) => Number.isSafeInteger(source[name]) && (source[name] as number) >= 0
    ? source[name] as number
    : undefined;
  const usage: ReadingUsage = {};
  const inputTokens = take('inputTokens');
  const outputTokens = take('outputTokens');
  const totalTokens = take('totalTokens');
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  return Object.keys(usage).length ? usage : null;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function processClaim(
  pool: Pool,
  provider: ReadingProvider,
  claim: ReadingClaim,
  signal: AbortSignal,
  startedAt: number,
  onEvent?: RunWorkerOptions['onEvent'],
): Promise<void> {
  try {
    const context = contextForClaim(claim);
    const generated = await provider.generate({ context, promptVersion: claim.promptVersion, contractVersion: claim.contractVersion, signal });
    const result = validateReadingResult(generated.result, context, claim.contractVersion);
    const usage = normalizeUsage(generated.usage);
    if (await completeReading(pool, claim, { ...generated, result, usage, aiGenerated: provider.aiGenerated })) {
      emitWorkerEvent(onEvent, {
        event: 'reading_attempt_finished', readingId: claim.readingId, attemptId: claim.attemptId,
        attemptNo: claim.attemptNo, provider: provider.name, model: provider.model,
        status: 'SUCCEEDED', durationMs: Math.max(0, Date.now() - startedAt), usage,
      });
    } else {
      emitWorkerEvent(onEvent, {
        event: 'reading_attempt_finished', readingId: claim.readingId, attemptId: claim.attemptId,
        attemptNo: claim.attemptNo, provider: provider.name, model: provider.model,
        status: 'STALE', durationMs: Math.max(0, Date.now() - startedAt),
      });
    }
  } catch (error) {
    const rawFailure = error instanceof AiProviderError
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : { code: 'AI_WORKER_FAILURE', message: 'AI worker failed', retryable: true };
    const failure = { ...rawFailure, code: normalizeFailureCode(rawFailure.code) };
    if (await failReading(pool, claim, failure)) {
      emitWorkerEvent(onEvent, {
        event: 'reading_attempt_finished', readingId: claim.readingId, attemptId: claim.attemptId,
        attemptNo: claim.attemptNo, provider: provider.name, model: provider.model,
        status: 'FAILED', durationMs: Math.max(0, Date.now() - startedAt), errorCode: failure.code,
      });
    } else {
      emitWorkerEvent(onEvent, {
        event: 'reading_attempt_finished', readingId: claim.readingId, attemptId: claim.attemptId,
        attemptNo: claim.attemptNo, provider: provider.name, model: provider.model,
        status: 'STALE', durationMs: Math.max(0, Date.now() - startedAt),
      });
    }
  }
}

export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('worker concurrency must be between 1 and 2');
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const active = new Set<Promise<void>>();
  const workerController = new AbortController();
  const signal = AbortSignal.any([options.signal, workerController.signal]);
  let hasProcessingFailure = false;
  let processingFailure: unknown;
  let hasLoopFailure = false;
  let loopFailure: unknown;

  function schedule(claim: ReadingClaim): void {
    const startedAt = Date.now();
    emitWorkerEvent(options.onEvent, {
      event: 'reading_attempt_started', readingId: claim.readingId, attemptId: claim.attemptId,
      attemptNo: claim.attemptNo, provider: options.provider.name, model: options.provider.model,
    });
    const task = processClaim(options.pool, options.provider, claim, signal, startedAt, options.onEvent)
      .catch(error => {
        if (!hasProcessingFailure) {
          hasProcessingFailure = true;
          processingFailure = error;
        }
        workerController.abort();
      })
      .finally(() => active.delete(task));
    active.add(task);
  }

  try {
    while (!signal.aborted) {
      await expireReadings(options.pool);
      if (hasProcessingFailure) throw processingFailure;
      let claimed = false;
      while (!signal.aborted && active.size < concurrency) {
        const claim = await claimNextReading(options.pool, { provider: options.provider.name, model: options.provider.model });
        if (!claim) break;
        claimed = true;
        // A claim can finish after another task has aborted the worker. It still
        // owns a RUNNING attempt, so schedule it with the aborted signal and drain it.
        schedule(claim);
        if (hasProcessingFailure || signal.aborted) break;
      }
      if (hasProcessingFailure) throw processingFailure;
      if (signal.aborted) break;
      if (active.size) await Promise.race(active);
      else if (!claimed) await abortableDelay(pollIntervalMs, signal);
    }
  } catch (error) {
    hasLoopFailure = true;
    loopFailure = hasProcessingFailure ? processingFailure : error;
  } finally {
    workerController.abort();
    await Promise.allSettled(active);
  }
  if (hasLoopFailure) throw loopFailure;
  if (hasProcessingFailure) throw processingFailure;
}
