import type { Pool } from 'pg';
import { contextForClaim } from '../ai/context.ts';
import { AiProviderError, type ReadingProvider } from '../ai/types.ts';
import { validateReadingResult } from '../ai/validate.ts';
import { claimNextReading, completeReading, expireReadings, failReading } from '../readings/attempts.ts';
import type { ReadingClaim } from '../readings/types.ts';

export interface RunWorkerOptions {
  pool: Pool;
  provider: ReadingProvider;
  signal: AbortSignal;
  concurrency?: number;
  pollIntervalMs?: number;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function processClaim(pool: Pool, provider: ReadingProvider, claim: ReadingClaim, signal: AbortSignal): Promise<void> {
  try {
    const context = contextForClaim(claim);
    const generated = await provider.generate({ context, promptVersion: claim.promptVersion, contractVersion: claim.contractVersion, signal });
    const result = validateReadingResult(generated.result, context, claim.contractVersion);
    await completeReading(pool, claim, { ...generated, result, aiGenerated: provider.aiGenerated });
  } catch (error) {
    const failure = error instanceof AiProviderError
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : { code: 'AI_WORKER_FAILURE', message: 'AI worker failed', retryable: true };
    await failReading(pool, claim, failure);
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
    const task = processClaim(options.pool, options.provider, claim, signal)
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
