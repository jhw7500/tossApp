import type { FromSchema } from 'json-schema-to-ts';
import type {
  createReadingBodySchema, retryReadingBodySchema, readingStatusSchema, readingResultSchema,
  readingResultCardSchema, readingSnapshotSchema, snapshotCardSchema, readingContextSchema,
  acceptedReadingSchema, readingErrorSchema, readingDetailSchema, readingHistorySchema,
} from '../../../contracts/reading.schemas.ts';

export type CreateReadingBody = FromSchema<typeof createReadingBodySchema>;
export type RetryReadingBody = FromSchema<typeof retryReadingBodySchema>;
export type ReadingStatus = FromSchema<typeof readingStatusSchema>;
export type ReadingResult = Omit<FromSchema<typeof readingResultSchema>, 'cards'> & { cards: Array<FromSchema<typeof readingResultCardSchema>> };
export type ReadingSnapshot = Omit<FromSchema<typeof readingSnapshotSchema>, 'cards'> & { cards: Array<FromSchema<typeof snapshotCardSchema>> };
export type ReadingContext = Omit<FromSchema<typeof readingContextSchema>, 'cards'> & { cards: ReadingSnapshot['cards'] };
export type AcceptedReading = FromSchema<typeof acceptedReadingSchema>;
export type ReadingError = FromSchema<typeof readingErrorSchema>;
export type ReadingDetail = Omit<FromSchema<typeof readingDetailSchema>, 'result'> & { result: ReadingResult | null };
export type ReadingHistory = FromSchema<typeof readingHistorySchema>;

export interface ReadingClaim {
  readingId: string;
  attemptId: string;
  attemptNo: number;
  snapshot: ReadingSnapshot;
  promptVersion: string;
  contractVersion: string;
  leaseExpiresAt: string;
}
export interface ReadingUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
export interface ReadingCompletion { result: ReadingResult; usage: ReadingUsage | null; aiGenerated: boolean; }
export type ReadingFailure = ReadingError;
export interface ReadingRow {
  id: string;
  user_id: string;
  person_id: string;
  status: ReadingStatus;
  current_attempt_no: number;
  request_snapshot: ReadingSnapshot;
  result_json: ReadingResult | null;
  error_json: ReadingError | null;
  ai_generated: boolean;
  contract_version: string;
  prompt_version: string;
  created_at: Date;
  updated_at: Date;
}
export interface AttemptRow {
  id: string;
  reading_id: string;
  attempt_no: number;
  status: ReadingStatus;
  queued_at: Date;
  lease_expires_at: Date | null;
  error_json: ReadingError | null;
}
