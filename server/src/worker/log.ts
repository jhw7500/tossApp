import type { WorkerEvent } from './run.ts';

export function formatWorkerEvent(event: WorkerEvent): string {
  return `${JSON.stringify(event)}\n`;
}
