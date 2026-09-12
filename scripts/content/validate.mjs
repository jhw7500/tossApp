import { CsvSyntaxError, parseCsv } from './csv.mjs';

export const HEADERS = [
  'card_code',
  'interpretation_id',
  'locale',
  'version',
  'is_active_version',
  'source_kind',
  'source_attribution',
  'content',
];

export const MAX_CANDIDATES_PER_CARD = 20;
export const MAX_CONTEXT_BYTES = 64 * 1024;
export const CONTEXT_LIMIT_NOTE = '이 수치는 원문 후보만 계산하며 실제 질문·상황·카드 위치를 포함한 전체 context 성공을 보장하지 않습니다.';

const SOURCE_KINDS = new Set(['editorial', 'licensed', 'synthetic_test']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

function emptySummary() {
  return {
    rowCount: 0,
    interpretationCount: 0,
    cardCount: 0,
    activeVersionCount: 0,
    cards: [],
    largestThreeKoKrCandidateBytes: 0,
    remainingContextBytes: MAX_CONTEXT_BYTES,
  };
}

function diagnostic(line, column, message) {
  return { line, column, message };
}

function isBlankRecord(record) {
  return record.fields.length === 1 && record.fields[0] === '';
}

function parseVersion(value) {
  if (!/^\d+$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 1 && version <= POSTGRES_INTEGER_MAX
    ? version
    : null;
}

function parseLocale(value) {
  try {
    return new Intl.Locale(value).toString();
  } catch {
    return null;
  }
}

function validateRow(record, errors) {
  const values = Object.fromEntries(HEADERS.map((header, index) => [header, record.fields[index]]));
  const rowErrorsBefore = errors.length;

  if (!values.card_code.trim()) {
    errors.push(diagnostic(record.line, 'card_code', '카드 코드는 공백일 수 없습니다.'));
  } else if (CONTROL_CHARACTER_PATTERN.test(values.card_code)) {
    errors.push(diagnostic(record.line, 'card_code', '카드 코드는 제어 문자를 포함할 수 없습니다.'));
  }
  if (!UUID_PATTERN.test(values.interpretation_id)) {
    errors.push(diagnostic(record.line, 'interpretation_id', 'interpretation_id는 하이픈을 포함한 UUID여야 합니다.'));
  }
  const canonicalLocale = parseLocale(values.locale);
  if (!canonicalLocale) {
    errors.push(diagnostic(record.line, 'locale', 'locale은 유효한 언어 태그여야 합니다.'));
  }
  const version = parseVersion(values.version);
  if (version === null) {
    errors.push(diagnostic(record.line, 'version', 'version은 1 이상의 정수이며 2147483647 이하여야 합니다.'));
  }
  if (values.is_active_version !== 'true' && values.is_active_version !== 'false') {
    errors.push(diagnostic(record.line, 'is_active_version', 'is_active_version은 true 또는 false여야 합니다.'));
  }
  if (!SOURCE_KINDS.has(values.source_kind)) {
    errors.push(diagnostic(record.line, 'source_kind', 'source_kind는 editorial, licensed, synthetic_test 중 하나여야 합니다.'));
  }
  if (!values.source_attribution.trim()) {
    errors.push(diagnostic(record.line, 'source_attribution', '출처 표기는 공백일 수 없습니다.'));
  }
  if (!values.content.trim()) {
    errors.push(diagnostic(record.line, 'content', '본문은 공백일 수 없습니다.'));
  }

  if (errors.length !== rowErrorsBefore) return null;

  return {
    line: record.line,
    cardCode: values.card_code,
    interpretationId: values.interpretation_id.toLowerCase(),
    locale: canonicalLocale,
    version,
    isActiveVersion: values.is_active_version === 'true',
    sourceKind: values.source_kind,
    sourceAttribution: values.source_attribution,
    content: values.content,
  };
}

function validateGroups(rows, errors) {
  const groups = new Map();
  const seenVersions = new Map();

  for (const row of rows) {
    const versionKey = `${row.interpretationId}:${row.version}`;
    const firstVersionLine = seenVersions.get(versionKey);
    if (firstVersionLine !== undefined) {
      errors.push(diagnostic(
        row.line,
        'version',
        `interpretation_id와 version 조합이 ${firstVersionLine}행과 중복됩니다.`,
      ));
    } else {
      seenVersions.set(versionKey, row.line);
    }

    const group = groups.get(row.interpretationId);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(row.interpretationId, { first: row, rows: [row] });
    }
  }

  const activeRows = [];
  for (const group of groups.values()) {
    let consistent = true;
    for (const row of group.rows.slice(1)) {
      if (row.cardCode !== group.first.cardCode) {
        errors.push(diagnostic(row.line, 'card_code', '같은 interpretation_id의 card_code는 동일해야 합니다.'));
        consistent = false;
      }
      if (row.locale !== group.first.locale) {
        errors.push(diagnostic(row.line, 'locale', '같은 interpretation_id의 locale은 동일해야 합니다.'));
        consistent = false;
      }
    }

    const active = group.rows.filter(row => row.isActiveVersion);
    if (active.length !== 1) {
      errors.push(diagnostic(
        group.first.line,
        'is_active_version',
        '각 interpretation_id에는 활성 버전이 정확히 하나 있어야 합니다.',
      ));
      continue;
    }
    if (consistent) activeRows.push(active[0]);
  }

  return { groups, activeRows };
}

function buildCardSummary(activeRows, errors) {
  const candidatesByCardLocale = new Map();

  for (const row of activeRows) {
    const key = `${row.cardCode}\u0000${row.locale}`;
    const group = candidatesByCardLocale.get(key) ?? {
      cardCode: row.cardCode,
      locale: row.locale,
      line: row.line,
      candidates: [],
    };
    group.candidates.push({
      interpretationId: row.interpretationId,
      version: row.version,
      text: row.content,
      sourceKind: row.sourceKind,
      sourceAttribution: row.sourceAttribution,
    });
    candidatesByCardLocale.set(key, group);
  }

  const cards = [...candidatesByCardLocale.values()]
    .map(group => {
      group.candidates.sort((left, right) => left.interpretationId.localeCompare(right.interpretationId));
      if (group.candidates.length > MAX_CANDIDATES_PER_CARD) {
        errors.push(diagnostic(
          group.line,
          'active candidates',
          `${group.cardCode}/${group.locale}의 활성 원문이 20개를 초과합니다.`,
        ));
      }
      return {
        cardCode: group.cardCode,
        locale: group.locale,
        candidateCount: group.candidates.length,
        candidateBytes: Buffer.byteLength(JSON.stringify(group.candidates), 'utf8'),
      };
    })
    .sort((left, right) => (
      left.cardCode.localeCompare(right.cardCode) || left.locale.localeCompare(right.locale)
    ));

  const largestThreeKoKrCandidateBytes = cards
    .filter(card => card.locale === 'ko-KR')
    .map(card => card.candidateBytes)
    .sort((left, right) => right - left)
    .slice(0, 3)
    .reduce((total, bytes) => total + bytes, 0);

  if (largestThreeKoKrCandidateBytes > MAX_CONTEXT_BYTES) {
    errors.push(diagnostic(
      1,
      'context bytes',
      '가장 큰 ko-KR 카드 3장의 원문 후보 합계가 64 KiB를 초과합니다.',
    ));
  }

  return {
    cards,
    largestThreeKoKrCandidateBytes,
    remainingContextBytes: Math.max(0, MAX_CONTEXT_BYTES - largestThreeKoKrCandidateBytes),
  };
}

export function validateContentCsv(source) {
  const errors = [];
  const warnings = [];
  let records;

  try {
    records = parseCsv(source);
  } catch (error) {
    if (error instanceof CsvSyntaxError) {
      errors.push(diagnostic(error.line, String(error.column), error.message));
      return { errors, warnings, summary: emptySummary() };
    }
    throw error;
  }

  const header = records[0];
  if (!header || !HEADERS.every((name, index) => header.fields[index] === name) || header.fields.length !== HEADERS.length) {
    errors.push(diagnostic(1, 'header', `헤더 순서는 ${HEADERS.join(',')}여야 합니다.`));
    return { errors, warnings, summary: emptySummary() };
  }

  const dataRecords = records.slice(1).filter(record => !isBlankRecord(record));
  if (dataRecords.length === 0) {
    errors.push(diagnostic(1, 'row', '검증할 데이터 행이 하나 이상 필요합니다.'));
  }

  const typedRows = [];
  for (const record of dataRecords) {
    if (record.fields.length !== HEADERS.length) {
      errors.push(diagnostic(record.line, 'row', `데이터 행은 ${HEADERS.length}개 열이어야 합니다.`));
      continue;
    }
    const typed = validateRow(record, errors);
    if (typed) typedRows.push(typed);
  }

  const warnedLocales = new Set();
  for (const row of typedRows) {
    if (row.locale !== 'ko-KR' && !warnedLocales.has(row.locale)) {
      warnings.push(diagnostic(
        row.line,
        'locale',
        `${row.locale}은 유효하지만 현재 런타임은 정확히 ko-KR인 원문만 사용합니다.`,
      ));
      warnedLocales.add(row.locale);
    }
  }

  const { groups, activeRows } = validateGroups(typedRows, errors);
  const cardSummary = buildCardSummary(activeRows, errors);
  const cardCodes = new Set(cardSummary.cards.map(card => card.cardCode));

  return {
    errors,
    warnings,
    summary: {
      rowCount: dataRecords.length,
      interpretationCount: groups.size,
      cardCount: cardCodes.size,
      activeVersionCount: activeRows.length,
      ...cardSummary,
    },
  };
}
