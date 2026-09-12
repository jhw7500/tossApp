import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildQualityReviewPacket,
  evaluateQualityFixture,
  evaluateQualityReview,
  type QualityReview,
} from '../src/ai/quality-evaluation.ts';
import type { ReadingContext, ReadingResult } from '../src/readings/types.ts';

const context: ReadingContext = {
  relationshipCode: 'crush',
  currentSituation: '최근 대화가 줄었어요',
  question: {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    version: 1,
    text: '지금 관계에서 살펴볼 점은?',
    isCustom: false,
  },
  cards: [
    {
      cardId: '11111111-1111-4111-8111-111111111111',
      code: 'first',
      name: '첫 카드',
      arcana: 'major',
      imageUrl: null,
      positionIndex: 1,
      label: '현재',
      description: null,
      candidates: [
        {
          interpretationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          version: 1,
          text: '선택한 첫 원문',
          sourceKind: 'editorial',
          sourceAttribution: 'reader-a',
        },
        {
          interpretationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
          version: 2,
          text: '선택하지 않은 첫 원문',
          sourceKind: 'editorial',
          sourceAttribution: 'reader-a',
        },
      ],
    },
    {
      cardId: '22222222-2222-4222-8222-222222222222',
      code: 'second',
      name: '둘째 카드',
      arcana: 'major',
      imageUrl: null,
      positionIndex: 2,
      label: '상대',
      description: null,
      candidates: [{
        interpretationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        version: 1,
        text: '둘째 원문',
        sourceKind: 'licensed',
        sourceAttribution: 'reader-b',
      }],
    },
    {
      cardId: '33333333-3333-4333-8333-333333333333',
      code: 'third',
      name: '셋째 카드',
      arcana: 'major',
      imageUrl: null,
      positionIndex: 3,
      label: '흐름',
      description: null,
      candidates: [{
        interpretationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        version: 1,
        text: '셋째 원문',
        sourceKind: 'editorial',
        sourceAttribution: 'reader-c',
      }],
    },
  ],
};

const result: ReadingResult = {
  cards: [
    {
      positionIndex: 1,
      cardId: context.cards[0].cardId,
      text: '첫 카드 결과',
      evidence: [{ interpretationId: context.cards[0].candidates[0].interpretationId, version: 1 }],
    },
    {
      positionIndex: 2,
      cardId: context.cards[1].cardId,
      text: '둘째 카드 결과',
      evidence: [{ interpretationId: context.cards[1].candidates[0].interpretationId, version: 1 }],
    },
    {
      positionIndex: 3,
      cardId: context.cards[2].cardId,
      text: '셋째 카드 결과',
      evidence: [{ interpretationId: context.cards[2].candidates[0].interpretationId, version: 1 }],
    },
  ],
  overallReading: '세 카드의 연결 결과',
  summary: '관계를 천천히 살펴보세요.',
};

test('review packet preserves every candidate and marks the exact selected evidence', () => {
  const packet = buildQualityReviewPacket('reader-case-1', context, result);

  assert.equal(packet.scope, 'reader_content');
  assert.deepEqual(packet.question, {
    relationshipCode: 'crush',
    currentSituation: '최근 대화가 줄었어요',
    text: '지금 관계에서 살펴볼 점은?',
    isCustom: false,
  });
  assert.deepEqual(packet.cards[0].candidates, [
    {
      interpretationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      version: 1,
      text: '선택한 첫 원문',
      sourceKind: 'editorial',
      sourceAttribution: 'reader-a',
      selected: true,
    },
    {
      interpretationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      version: 2,
      text: '선택하지 않은 첫 원문',
      sourceKind: 'editorial',
      sourceAttribution: 'reader-a',
      selected: false,
    },
  ]);
  assert.equal(packet.cards[0].responseText, '첫 카드 결과');
});

test('synthetic source results can never become a reader-content quality pass', () => {
  const syntheticContext = structuredClone(context);
  syntheticContext.cards[0].candidates[0].sourceKind = 'synthetic_test';
  const packet = buildQualityReviewPacket('synthetic-case', syntheticContext, result);

  const evaluation = evaluateQualityReview(packet, {
    meaningPreservation: 'pass',
    evidenceSelection: 'pass',
    questionContext: 'pass',
    overallFlow: 'pass',
    nonDefinitiveLanguage: 'pass',
  });

  assert.deepEqual(evaluation, {
    caseId: 'synthetic-case',
    status: 'MECHANICS_ONLY',
    failedCriteria: [],
  });
});

test('reader-content review reports each failed quality criterion', () => {
  const packet = buildQualityReviewPacket('reader-case-2', context, result);

  const evaluation = evaluateQualityReview(packet, {
    meaningPreservation: 'pass',
    evidenceSelection: 'pass',
    questionContext: 'fail',
    overallFlow: 'pass',
    nonDefinitiveLanguage: 'pass',
  });

  assert.deepEqual(evaluation, {
    caseId: 'reader-case-2',
    status: 'FAIL',
    failedCriteria: ['questionContext'],
  });
});

test('reader-content review passes only when every quality criterion passes', () => {
  const packet = buildQualityReviewPacket('reader-case-3', context, result);

  const evaluation = evaluateQualityReview(packet, {
    meaningPreservation: 'pass',
    evidenceSelection: 'pass',
    questionContext: 'pass',
    overallFlow: 'pass',
    nonDefinitiveLanguage: 'pass',
  });

  assert.deepEqual(evaluation, {
    caseId: 'reader-case-3',
    status: 'PASS',
    failedCriteria: [],
  });
});

test('direct review evaluation rejects missing runtime criteria', () => {
  const packet = buildQualityReviewPacket('unchecked-review', context, result);

  assert.throws(
    () => evaluateQualityReview(packet, {} as QualityReview),
    /invalid quality review/i,
  );
});

test('direct review evaluation derives mechanics-only status from candidate sources', () => {
  const syntheticContext = structuredClone(context);
  syntheticContext.cards[0].candidates[0].sourceKind = 'synthetic_test';
  const packet = buildQualityReviewPacket('spoofed-scope', syntheticContext, result);
  packet.scope = 'reader_content';

  const evaluation = evaluateQualityReview(packet, {
    meaningPreservation: 'pass',
    evidenceSelection: 'pass',
    questionContext: 'pass',
    overallFlow: 'pass',
    nonDefinitiveLanguage: 'pass',
  });

  assert.equal(evaluation.status, 'MECHANICS_ONLY');
});

test('review packet rejects duplicate evidence identities within a card', () => {
  const duplicateContext = structuredClone(context);
  duplicateContext.cards[0].candidates.push({
    ...duplicateContext.cards[0].candidates[0],
    text: '같은 ID와 버전을 가진 충돌 원문',
  });

  assert.throws(
    () => buildQualityReviewPacket('duplicate-evidence', duplicateContext, result),
    /duplicate quality source candidate/i,
  );
});

test('review packet rejects one evidence identity reused by different cards', () => {
  const duplicateContext = structuredClone(context);
  duplicateContext.cards[1].candidates = [{
    ...duplicateContext.cards[0].candidates[0],
    text: '다른 카드에 연결된 충돌 원문',
  }];
  const duplicateResult = structuredClone(result);
  duplicateResult.cards[1].evidence = [{
    interpretationId: duplicateContext.cards[0].candidates[0].interpretationId,
    version: duplicateContext.cards[0].candidates[0].version,
  }];

  assert.throws(
    () => buildQualityReviewPacket('cross-card-duplicate', duplicateContext, duplicateResult),
    /duplicate quality source candidate/i,
  );
});

test('review packet preserves the card-position description used by the model', () => {
  const describedContext = structuredClone(context);
  describedContext.cards[0].description = '현재 겉으로 드러난 관계 상태';

  const packet = buildQualityReviewPacket('position-description', describedContext, result);

  assert.equal(packet.cards[0].positionDescription, '현재 겉으로 드러난 관계 상태');
});

test('fixture evaluator rejects an incomplete human review', () => {
  assert.throws(() => evaluateQualityFixture({
    caseId: 'incomplete-review',
    context,
    result,
    review: {
      meaningPreservation: 'pass',
      evidenceSelection: 'pass',
      questionContext: 'pass',
      overallFlow: 'pass',
    },
  }), /quality evaluation fixture: \/review required nonDefinitiveLanguage/i);
});

test('quality evaluation CLI prints a machine-readable reader-content verdict', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tarororo-quality-'));
  const fixturePath = join(directory, 'reader-case.json');
  try {
    writeFileSync(fixturePath, JSON.stringify({
      caseId: 'reader-cli-case',
      context,
      result,
      review: {
        meaningPreservation: 'pass',
        evidenceSelection: 'pass',
        questionContext: 'pass',
        overallFlow: 'pass',
        nonDefinitiveLanguage: 'pass',
      },
    }));

    const completed = spawnSync(process.execPath, [
      '--experimental-strip-types',
      'src/ai/evaluate-quality.ts',
      fixturePath,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(completed.status, 0, completed.stderr);
    assert.deepEqual(JSON.parse(completed.stdout), {
      caseId: 'reader-cli-case',
      status: 'PASS',
      failedCriteria: [],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
