import { Ajv } from 'ajv';
import { readingContextSchema, readingResultSchema } from '../../../contracts/reading.schemas.ts';
import type { ReadingContext, ReadingResult } from '../readings/types.ts';
import { validateReadingResult } from './validate.ts';

interface QualityReviewCandidate {
  interpretationId: string;
  version: number;
  text: string;
  sourceKind: string;
  sourceAttribution: string;
  selected: boolean;
}

interface QualityReviewCard {
  positionIndex: number;
  cardId: string;
  cardName: string;
  positionLabel: string;
  positionDescription: string | null;
  responseText: string;
  candidates: QualityReviewCandidate[];
}

export interface QualityReviewPacket {
  caseId: string;
  scope: 'reader_content' | 'mechanics_only';
  question: {
    relationshipCode: string;
    currentSituation: string | null;
    text: string;
    isCustom: boolean;
  };
  cards: QualityReviewCard[];
  overallReading: string;
  summary: string;
}

export type QualityCriterion =
  | 'meaningPreservation'
  | 'evidenceSelection'
  | 'questionContext'
  | 'overallFlow'
  | 'nonDefinitiveLanguage';

export type QualityReview = Record<QualityCriterion, 'pass' | 'fail'>;

export interface QualityEvaluation {
  caseId: string;
  status: 'PASS' | 'FAIL' | 'MECHANICS_ONLY';
  failedCriteria: QualityCriterion[];
}

const QUALITY_CRITERIA: QualityCriterion[] = [
  'meaningPreservation',
  'evidenceSelection',
  'questionContext',
  'overallFlow',
  'nonDefinitiveLanguage',
];

function isQualityReview(value: unknown): value is QualityReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const review = value as Record<string, unknown>;
  return Object.keys(review).length === QUALITY_CRITERIA.length
    && QUALITY_CRITERIA.every(criterion => review[criterion] === 'pass' || review[criterion] === 'fail');
}

interface QualityEvaluationFixture {
  caseId: string;
  context: ReadingContext;
  result: ReadingResult;
  review: QualityReview;
}

const reviewProperties = Object.fromEntries(QUALITY_CRITERIA.map(criterion => [
  criterion,
  { type: 'string', enum: ['pass', 'fail'] },
]));
const qualityFixtureSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['caseId', 'context', 'result', 'review'],
  properties: {
    caseId: { type: 'string', minLength: 1, maxLength: 120 },
    context: readingContextSchema,
    result: readingResultSchema,
    review: {
      type: 'object',
      additionalProperties: false,
      required: QUALITY_CRITERIA,
      properties: reviewProperties,
    },
  },
} as const;
const validateFixture = new Ajv({
  allErrors: true,
  strict: true,
  formats: { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i },
}).compile(qualityFixtureSchema);

export function evaluateQualityFixture(value: unknown): QualityEvaluation {
  if (!validateFixture(value)) {
    const details = (validateFixture.errors ?? []).slice(0, 3).map(error => {
      const missing = 'missingProperty' in error.params ? ` ${String(error.params.missingProperty)}` : '';
      return `${error.instancePath || '/'} ${error.keyword}${missing}`;
    });
    throw new Error(`invalid quality evaluation fixture: ${details.join('; ')}`);
  }
  const fixture = value as QualityEvaluationFixture;
  const packet = buildQualityReviewPacket(fixture.caseId, fixture.context, fixture.result);
  return evaluateQualityReview(packet, fixture.review);
}

export function evaluateQualityReview(
  packet: QualityReviewPacket,
  review: QualityReview,
): QualityEvaluation {
  if (!isQualityReview(review)) throw new Error('invalid quality review');
  const failedCriteria = QUALITY_CRITERIA.filter(criterion => review[criterion] === 'fail');
  const mechanicsOnly = packet.cards.some(card => card.candidates.some(candidate => candidate.sourceKind === 'synthetic_test'));
  return {
    caseId: packet.caseId,
    status: mechanicsOnly
      ? 'MECHANICS_ONLY'
      : failedCriteria.length === 0 ? 'PASS' : 'FAIL',
    failedCriteria,
  };
}

export function buildQualityReviewPacket(
  caseId: string,
  context: ReadingContext,
  value: ReadingResult,
): QualityReviewPacket {
  const result = validateReadingResult(value, context, 'reading-result.v1');
  const candidateIdentities = new Set<string>();
  for (const card of context.cards) {
    for (const candidate of card.candidates) {
      const identity = `${candidate.interpretationId}:${candidate.version}`;
      if (candidateIdentities.has(identity)) throw new Error('duplicate quality source candidate');
      candidateIdentities.add(identity);
    }
  }
  return {
    caseId,
    scope: context.cards.some(card => card.candidates.some(candidate => candidate.sourceKind === 'synthetic_test'))
      ? 'mechanics_only'
      : 'reader_content',
    question: {
      relationshipCode: context.relationshipCode,
      currentSituation: context.currentSituation,
      text: context.question.text,
      isCustom: context.question.isCustom,
    },
    cards: context.cards.map(card => {
      const cardResult = result.cards.find(item => item.positionIndex === card.positionIndex)!;
      const selected = new Set(cardResult.evidence.map(reference => `${reference.interpretationId}:${reference.version}`));
      return {
        positionIndex: card.positionIndex,
        cardId: card.cardId,
        cardName: card.name,
        positionLabel: card.label,
        positionDescription: card.description,
        responseText: cardResult.text,
        candidates: card.candidates.map(candidate => ({
          ...candidate,
          selected: selected.has(`${candidate.interpretationId}:${candidate.version}`),
        })),
      };
    }),
    overallReading: result.overallReading,
    summary: result.summary,
  };
}
