import type { ReadingContext, ReadingResult, ReadingUsage } from '../readings/types.ts';

export interface GenerateReadingInput {
  context: ReadingContext;
  promptVersion: string;
  contractVersion: string;
  signal?: AbortSignal;
}

export interface GeneratedReading {
  result: ReadingResult;
  usage: ReadingUsage | null;
}

export interface ReadingProvider {
  readonly name: string;
  readonly model: string;
  readonly aiGenerated: boolean;
  generate(input: GenerateReadingInput): Promise<GeneratedReading>;
}

export class AiProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean, message = 'AI provider request failed', options?: ErrorOptions) {
    super(message, options);
    this.name = 'AiProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}
