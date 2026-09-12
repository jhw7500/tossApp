import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_CONTEXT_BYTES, validateContentCsv } from './validate.mjs';

const HEADERS = [
  'card_code',
  'interpretation_id',
  'locale',
  'version',
  'is_active_version',
  'source_kind',
  'source_attribution',
  'content',
];

function csvField(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows, headers = HEADERS) {
  return [headers, ...rows].map(row => row.map(csvField).join(',')).join('\n');
}

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function row(overrides = {}) {
  const value = {
    card_code: 'the-fool',
    interpretation_id: uuid(1),
    locale: 'ko-KR',
    version: '1',
    is_active_version: 'true',
    source_kind: 'synthetic_test',
    source_attribution: 'synthetic test fixture',
    content: '시험용 원문',
    ...overrides,
  };
  return HEADERS.map(header => value[header]);
}

function hasDiagnostic(result, column, message) {
  return result.errors.some(error => error.column === column && message.test(error.message));
}

test('a valid active source produces a runtime-shaped byte summary', () => {
  const id = uuid(1);
  const result = validateContentCsv(csv([row({ content: '한글 원문' })]));
  const expectedBytes = Buffer.byteLength(JSON.stringify([{
    interpretationId: id,
    version: 1,
    text: '한글 원문',
    sourceKind: 'synthetic_test',
    sourceAttribution: 'synthetic test fixture',
  }]), 'utf8');

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.rowCount, 1);
  assert.equal(result.summary.interpretationCount, 1);
  assert.equal(result.summary.cardCount, 1);
  assert.equal(result.summary.activeVersionCount, 1);
  assert.deepEqual(result.summary.cards, [{
    cardCode: 'the-fool',
    locale: 'ko-KR',
    candidateCount: 1,
    candidateBytes: expectedBytes,
  }]);
  assert.equal(result.summary.largestThreeKoKrCandidateBytes, expectedBytes);
  assert.equal(result.summary.remainingContextBytes, MAX_CONTEXT_BYTES - expectedBytes);
});

test('CSV syntax errors become source diagnostics', () => {
  const result = validateContentCsv('a,b\n1,"열린 값');

  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.errors[0], {
    line: 2,
    column: '3',
    message: '닫는 인용부호가 없습니다.',
  });
});

test('headers must match the complete ordered contract', () => {
  const result = validateContentCsv(csv([row()], [...HEADERS].reverse()));

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 1);
  assert.equal(result.errors[0].column, 'header');
  assert.match(result.errors[0].message, /헤더 순서/);
});

test('rows must have the same number of columns as the header', () => {
  const result = validateContentCsv(`${HEADERS.join(',')}\nthe-fool,too-few`);

  assert.equal(result.errors[0].line, 2);
  assert.equal(result.errors[0].column, 'row');
  assert.match(result.errors[0].message, /8개/);
});

test('at least one nonblank data row is required', () => {
  const result = validateContentCsv(`${HEADERS.join(',')}\n\n`);

  assert.ok(hasDiagnostic(result, 'row', /데이터 행/));
});

test('required text fields reject ECMAScript whitespace', () => {
  const blankContent = validateContentCsv(csv([row({ content: '　' })]));
  const blankAttribution = validateContentCsv(csv([row({ source_attribution: '\u00a0' })]));
  const blankCard = validateContentCsv(csv([row({ card_code: ' ' })]));

  assert.deepEqual(blankContent.errors[0], {
    line: 2,
    column: 'content',
    message: '본문은 공백일 수 없습니다.',
  });
  assert.ok(hasDiagnostic(blankAttribution, 'source_attribution', /출처/));
  assert.ok(hasDiagnostic(blankCard, 'card_code', /카드 코드/));
});

test('database text fields reject NUL characters', () => {
  const nulAttribution = validateContentCsv(csv([row({ source_attribution: 'source\0name' })]));
  const nulContent = validateContentCsv(csv([row({ content: '본문\0내용' })]));

  assert.ok(hasDiagnostic(nulAttribution, 'source_attribution', /NUL/));
  assert.ok(hasDiagnostic(nulContent, 'content', /NUL/));
});

test('typed fields reject malformed values', () => {
  const cases = [
    ['interpretation_id', 'not-a-uuid', /UUID/],
    ['locale', 'ko_KR', /locale/],
    ['version', '0', /1 이상의 정수/],
    ['version', '1.5', /1 이상의 정수/],
    ['version', '2147483648', /2147483647 이하/],
    ['is_active_version', 'TRUE', /true 또는 false/],
    ['source_kind', 'generated', /source_kind/],
  ];

  for (const [column, value, message] of cases) {
    const result = validateContentCsv(csv([row({ [column]: value })]));
    assert.ok(hasDiagnostic(result, column, message), `${column} should reject ${value}`);
  }
});

test('PostgreSQL integer maximum is accepted as a version', () => {
  const result = validateContentCsv(csv([row({ version: '2147483647' })]));

  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.cards[0].candidateCount, 1);
});

test('card codes reject control characters', () => {
  const result = validateContentCsv(csv([row({ card_code: 'the-fool\nforged-line' })]));

  assert.ok(hasDiagnostic(result, 'card_code', /제어 문자/));
});

test('duplicate interpretation versions are rejected with the first line', () => {
  const result = validateContentCsv(csv([row(), row()]));

  assert.ok(hasDiagnostic(result, 'version', /2행과 중복/));
});

test('card and locale stay stable across one interpretation history', () => {
  const changedCard = validateContentCsv(csv([
    row({ version: '1', is_active_version: 'false' }),
    row({ card_code: 'the-star', version: '2' }),
  ]));
  const changedLocale = validateContentCsv(csv([
    row({ version: '1', is_active_version: 'false' }),
    row({ locale: 'en-US', version: '2' }),
  ]));

  assert.ok(hasDiagnostic(changedCard, 'card_code', /같은 interpretation_id/));
  assert.ok(hasDiagnostic(changedLocale, 'locale', /같은 interpretation_id/));
});

test('every interpretation has exactly one active version', () => {
  const missing = validateContentCsv(csv([
    row({ version: '1', is_active_version: 'false' }),
    row({ version: '2', is_active_version: 'false' }),
  ]));
  const duplicate = validateContentCsv(csv([
    row({ version: '1' }),
    row({ version: '2' }),
  ]));

  assert.ok(hasDiagnostic(missing, 'is_active_version', /정확히 하나/));
  assert.ok(hasDiagnostic(duplicate, 'is_active_version', /정확히 하나/));
});

test('version gaps and per-version source metadata changes are allowed', () => {
  const result = validateContentCsv(csv([
    row({
      version: '1',
      is_active_version: 'false',
      source_kind: 'licensed',
      source_attribution: 'license v1',
    }),
    row({
      version: '3',
      source_kind: 'editorial',
      source_attribution: 'editor correction',
    }),
  ]));

  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.activeVersionCount, 1);
});

test('each valid locale outside ko-KR creates one warning', () => {
  const result = validateContentCsv(csv([
    row({ interpretation_id: uuid(1), locale: 'en-US' }),
    row({ interpretation_id: uuid(2), locale: 'en-US' }),
  ]));

  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].column, 'locale');
  assert.match(result.warnings[0].message, /현재 런타임/);
});

test('locale comparisons and summaries use the canonical locale', () => {
  const result = validateContentCsv(csv([
    row({ version: '1', is_active_version: 'false', locale: 'ko-kr' }),
    row({ version: '2', locale: 'ko-KR' }),
  ]));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.cards[0].locale, 'ko-KR');
  assert.ok(result.summary.largestThreeKoKrCandidateBytes > 0);
});

test('twenty active candidates pass and twenty-one fail for one card and locale', () => {
  const twenty = Array.from({ length: 20 }, (_, index) => row({
    interpretation_id: uuid(index + 1),
  }));
  const accepted = validateContentCsv(csv(twenty));
  const rejected = validateContentCsv(csv([
    ...twenty,
    row({ interpretation_id: uuid(21) }),
  ]));

  assert.deepEqual(accepted.errors, []);
  assert.equal(accepted.summary.cards[0].candidateCount, 20);
  assert.ok(hasDiagnostic(rejected, 'active candidates', /20개를 초과/));
});

test('the three largest ko-KR candidate arrays cannot exceed 64 KiB', () => {
  const rows = ['the-fool', 'the-lovers', 'the-star'].map((cardCode, index) => row({
    card_code: cardCode,
    interpretation_id: uuid(index + 1),
    content: 'x'.repeat(22_000),
  }));
  const result = validateContentCsv(csv(rows));

  assert.ok(result.summary.largestThreeKoKrCandidateBytes > MAX_CONTEXT_BYTES);
  assert.equal(result.summary.remainingContextBytes, 0);
  assert.ok(hasDiagnostic(result, 'context bytes', /64 KiB/));
});

test('candidate arrays equal to 64 KiB are rejected before runtime metadata is added', () => {
  const cardCodes = ['the-fool', 'the-lovers', 'the-star'];
  const seedRows = cardCodes.map((cardCode, index) => row({
    card_code: cardCode,
    interpretation_id: uuid(index + 1),
    content: 'x',
  }));
  const seed = validateContentCsv(csv(seedRows));
  const padding = MAX_CONTEXT_BYTES - seed.summary.largestThreeKoKrCandidateBytes;
  const exactRows = cardCodes.map((cardCode, index) => row({
    card_code: cardCode,
    interpretation_id: uuid(index + 1),
    content: index === 0 ? 'x'.repeat(padding + 1) : 'x',
  }));
  const result = validateContentCsv(csv(exactRows));

  assert.equal(result.summary.largestThreeKoKrCandidateBytes, MAX_CONTEXT_BYTES);
  assert.equal(result.summary.remainingContextBytes, 0);
  assert.ok(hasDiagnostic(result, 'context bytes', /64 KiB/));
});
