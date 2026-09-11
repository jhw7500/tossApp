import { Ajv } from 'ajv';
import { readingResultSchema } from '../../../contracts/reading.schemas.ts';
import type { ReadingContext, ReadingResult } from '../readings/types.ts';
import { AiProviderError } from './types.ts';

const ajv = new Ajv({ allErrors: true, strict: true, formats: { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i } });
const validateSchema = ajv.compile(readingResultSchema);
const invalid = () => new AiProviderError('AI_OUTPUT_INVALID', true, 'invalid AI output');

export function validateReadingResult(value: unknown, context: ReadingContext, contractVersion: string): ReadingResult {
  if (contractVersion !== 'reading-result.v1') throw new AiProviderError('AI_CONFIG_INVALID', false, 'unsupported contract version');
  if (!validateSchema(value)) throw invalid();
  const result = value as ReadingResult;
  if (!result.overallReading.trim() || !result.summary.trim()) throw invalid();
  const positions = new Set<number>();
  for (const card of result.cards) {
    if (!card.text.trim() || positions.has(card.positionIndex)) throw invalid();
    positions.add(card.positionIndex);
    const supplied = context.cards.find(input => input.positionIndex === card.positionIndex && input.cardId === card.cardId);
    if (!supplied) throw invalid();
    const evidence = new Set<string>();
    for (const reference of card.evidence) {
      const pair = `${reference.interpretationId}:${reference.version}`;
      if (evidence.has(pair) || !supplied.candidates.some(candidate => candidate.interpretationId === reference.interpretationId && candidate.version === reference.version)) throw invalid();
      evidence.add(pair);
    }
  }
  if (positions.size !== context.cards.length) throw invalid();
  return result;
}
