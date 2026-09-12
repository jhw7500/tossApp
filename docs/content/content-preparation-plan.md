# Tarot Content Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스프레드시트에서 내보낸 타로 원문 CSV를 DB 변경 없이 검사하는 템플릿, dry-run CLI, 작성 안내를 제공한다.

**Architecture:** 작은 상태 머신 CSV 파서가 행 번호를 보존한 레코드를 만들고, 순수 검증 모듈이 행·버전 그룹·활성 후보·UTF-8 크기를 검사한다. 얇은 CLI는 파일 입출력과 사람이 읽는 보고서, 종료 코드만 담당한다.

**Tech Stack:** Node.js 24.12.0, ECMAScript modules, Node 기본 `node:test`, 외부 패키지 없음

**Spec:** `docs/content/content-preparation-design.md`

## Global Constraints

- 변경 경로는 `content/`, `scripts/content/`, `docs/content/`로 제한한다.
- 실제 타로 의미를 생성하지 않으며 예제는 모두 `synthetic_test`로 표시한다.
- DB, migration, seed, server runtime, AI prompt를 변경하거나 실행하지 않는다.
- 입력은 선택적인 UTF-8 BOM, 쉼표, 인용부호, CRLF/LF, 인용 필드 안 줄바꿈을 지원하는 UTF-8 CSV다.
- 활성 원문 후보는 카드·locale당 최대 20개, 콘텐츠 후보 바이트 상한은 64 KiB다.
- 바이트 검사는 `Buffer.byteLength(JSON.stringify(value), 'utf8')`을 사용하고 원문을 자르지 않는다.
- CLI는 입력 또는 별도 산출물을 쓰지 않는 dry-run이다.

---

### Task 1: 행 번호를 보존하는 CSV 파서

**Files:**
- Create: `scripts/content/csv.mjs`
- Create: `scripts/content/csv.test.mjs`

**Interfaces:**
- Consumes: UTF-8로 디코딩된 CSV 문자열
- Produces: `parseCsv(source) -> Array<{ line: number, fields: string[] }>`
- Produces: `CsvSyntaxError` with numeric `line`, numeric `column`, and an actionable `message`

- [ ] **Step 1: 인용 필드 보존 테스트 작성**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv } from './csv.mjs';

test('BOM, CRLF, commas, escaped quotes, and quoted newlines are preserved', () => {
  const rows = parseCsv('\ufeffa,b\r\n1,"한글, \"\"인용\"\"\n둘째 줄"\r\n');
  assert.deepEqual(rows, [
    { line: 1, fields: ['a', 'b'] },
    { line: 2, fields: ['1', '한글, "인용"\n둘째 줄'] },
  ]);
});
```

- [ ] **Step 2: 테스트를 실행해 미구현 실패 확인**

Run: `node --test scripts/content/csv.test.mjs`

Expected: FAIL because `scripts/content/csv.mjs` does not exist.

- [ ] **Step 3: 문법 오류 위치 테스트 작성**

```js
import { CsvSyntaxError } from './csv.mjs';

test('an unclosed quoted field reports its source position', () => {
  assert.throws(
    () => parseCsv('a,b\n1,"열린 값'),
    error => error instanceof CsvSyntaxError && error.line === 2 && error.column === 3,
  );
});

test('a quote in an unquoted field is rejected', () => {
  assert.throws(() => parseCsv('a,b\n1,bad"value'), CsvSyntaxError);
});
```

- [ ] **Step 4: 상태 머신 파서 구현**

`scripts/content/csv.mjs`에서 다음 상태를 한 문자씩 처리한다.

```js
export class CsvSyntaxError extends Error {
  constructor(message, line, column) {
    super(message);
    this.name = 'CsvSyntaxError';
    this.line = line;
    this.column = column;
  }
}

export function parseCsv(source) {
  // Optional BOM is skipped only at offset 0.
  // States: at field start, in unquoted field, in quoted field, after closing quote.
  // A comma closes a field; CRLF or LF closes a record outside quoted fields.
  // Two quotes inside a quoted field decode to one quote.
  // Record.line is the physical line on which its first field starts.
  // A final line ending does not create a spurious empty record.
}
```

공백은 데이터로 보존하고 인용부호 밖에서 나타난 `"`와 닫는 인용부호 뒤의 쉼표·줄끝 이외 문자는 `CsvSyntaxError`로 거절한다.

- [ ] **Step 5: 파서 테스트 통과 확인**

Run: `node --test scripts/content/csv.test.mjs`

Expected: all parser tests PASS.

- [ ] **Step 6: 파서 커밋**

```bash
git add scripts/content/csv.mjs scripts/content/csv.test.mjs
git commit -m "feat(content): parse authoring CSV"
```

### Task 2: 원문 계약과 런타임 한도 검증

**Files:**
- Create: `scripts/content/validate.mjs`
- Create: `scripts/content/validate.test.mjs`
- Read: `server/src/readings/constants.ts`
- Read: `server/src/readings/snapshot.ts`

**Interfaces:**
- Consumes: `parseCsv()`가 반환한 레코드 또는 원본 CSV 문자열
- Produces: `validateContentCsv(source) -> { errors, warnings, summary }`
- Produces diagnostic: `{ line: number, column: string, message: string }`
- Produces summary: `{ rowCount, interpretationCount, cardCount, activeVersionCount, cards, largestThreeKoKrCandidateBytes, remainingContextBytes }`

- [ ] **Step 1: 행 계약 실패 테스트 작성**

정확한 헤더는 다음 상수로 고정한다.

```js
export const HEADERS = [
  'card_code', 'interpretation_id', 'locale', 'version',
  'is_active_version', 'source_kind', 'source_attribution', 'content',
];
```

테스트는 잘못된 헤더·열 수, 데이터 행 없음, 공백 본문·출처, 제어 문자가 있는 카드 코드, 비 UUID, 잘못된 locale, 0·소수·2147483648 이상 version, `true|false` 이외 boolean, 허용되지 않은 source kind 각각이 해당 행과 열의 오류를 만드는지 확인한다.

```js
const result = validateContentCsv(csvWith({ content: '　' }));
assert.deepEqual(result.errors[0], {
  line: 2,
  column: 'content',
  message: '본문은 공백일 수 없습니다.',
});
```

- [ ] **Step 2: 행 계약 테스트 실패 확인**

Run: `node --test scripts/content/validate.test.mjs`

Expected: FAIL because `validateContentCsv` does not exist.

- [ ] **Step 3: 행 파싱과 타입 검증 구현**

```js
export const MAX_CANDIDATES_PER_CARD = 20;
export const MAX_CONTEXT_BYTES = 64 * 1024;
export const SOURCE_KINDS = new Set(['editorial', 'licensed', 'synthetic_test']);

export function validateContentCsv(source) {
  const errors = [];
  const warnings = [];
  // Parse syntax errors become one diagnostic rather than escaping.
  // Exact headers and row widths are checked before named-field access.
  // Entirely blank physical records are ignored; an eight-column blank row is validated.
  // String visibility uses String.prototype.trim(), matching server whitespace behavior.
  // UUID uses canonical 8-4-4-4-12 hexadecimal form; locale uses new Intl.Locale(value), version fits PostgreSQL integer, and DB text fields reject NUL.
  // Only rows with usable typed values participate in group checks.
  return { errors, warnings, summary };
}
```

- [ ] **Step 4: 버전 그룹 불변식 테스트 작성**

다음 테스트 자료를 각각 구성한다.

- 같은 `(interpretation_id, version)` 두 행은 중복 오류다.
- 같은 ID의 `card_code` 또는 정규화된 `locale`이 바뀌면 오류다.
- 같은 ID의 활성 버전이 0개 또는 2개면 오류다.
- version 1과 3만 있는 그룹은 유효하다.
- 새 버전의 `source_kind`와 `source_attribution` 변경은 유효하다.
- 정규화 결과가 `ko-KR`이 아닌 유효한 locale마다 경고 하나를 만든다.

- [ ] **Step 5: 버전 그룹 검증 구현**

```js
const groups = new Map(); // interpretation_id -> typed rows
const seenVersions = new Map(); // `${interpretationId}:${version}` -> first source line

// Compare card_code and locale with the group's first row.
// Count is_active_version === true and require exactly one.
// Active rows become runtime candidates; inactive history remains validated but uncounted.
```

- [ ] **Step 6: 후보 수와 바이트 테스트 작성**

테스트는 같은 카드·locale의 활성 interpretation 20개가 통과하고 21개가 `MAX_CANDIDATES_PER_CARD` 오류가 되는지 확인한다. 한글 본문을 포함한 후보 객체의 바이트가 아래와 정확히 같은지도 확인한다.

```js
const expected = Buffer.byteLength(JSON.stringify([{
  interpretationId: id,
  version: 1,
  text: '한글 원문',
  sourceKind: 'synthetic_test',
  sourceAttribution: 'synthetic fixture',
}]), 'utf8');
assert.equal(result.summary.cards[0].candidateBytes, expected);
```

큰 ASCII 본문으로 `ko-KR` 카드 세 개의 후보 배열 합계가 64 KiB를 넘으면 오류, 그 이하면 `remainingContextBytes`가 `65536 - 합계`인지 확인한다.

- [ ] **Step 7: 후보 수와 바이트 검사 구현**

```js
const candidate = {
  interpretationId: row.interpretationId,
  version: row.version,
  text: row.content,
  sourceKind: row.sourceKind,
  sourceAttribution: row.sourceAttribution,
};
const candidateBytes = Buffer.byteLength(JSON.stringify(candidates), 'utf8');
```

카드·locale별 `cards` 결과는 `cardCode`, `locale`, `candidateCount`, `candidateBytes` 순서로 정렬한다. `ko-KR`에서 바이트가 큰 카드 세 개를 합산해 `largestThreeKoKrCandidateBytes`를 만들고 64 KiB를 넘으면 오류를 추가한다. 전체 runtime context의 성공 보장이 아니라는 경고 문구를 summary 출력용 상수로 제공한다.

- [ ] **Step 8: 검증 모듈 테스트 통과 확인**

Run: `node --test scripts/content/csv.test.mjs scripts/content/validate.test.mjs`

Expected: all parser and validation tests PASS.

- [ ] **Step 9: 검증 모듈 커밋**

```bash
git add scripts/content/validate.mjs scripts/content/validate.test.mjs
git commit -m "feat(content): validate tarot source rows"
```

### Task 3: Dry-run CLI, 템플릿, fixture, 사용 안내

**Files:**
- Create: `scripts/content/validate-content.mjs`
- Create: `scripts/content/validate-content.test.mjs`
- Create: `content/interpretations.template.csv`
- Create: `content/fixtures/synthetic-test.csv`
- Create: `content/fixtures/invalid-missing-active.csv`
- Create: `docs/content/README.md`

**Interfaces:**
- Consumes: `node scripts/content/validate-content.mjs <csv-file>`
- Produces: stdout summary and warnings on success, stderr diagnostics on failure
- Produces: exit code 0 for valid input and 1 for usage, read, parse, or validation failure

- [ ] **Step 1: CLI 프로세스 테스트 작성**

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('valid fixture exits zero and prints dry-run summary', () => {
  const run = spawnSync(process.execPath, [
    'scripts/content/validate-content.mjs',
    'content/fixtures/synthetic-test.csv',
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /검증 통과/);
  assert.match(run.stdout, /DB를 변경하지 않았습니다/);
});

test('invalid fixture exits one with source location', () => {
  const run = spawnSync(process.execPath, [
    'scripts/content/validate-content.mjs',
    'content/fixtures/invalid-missing-active.csv',
  ], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /invalid-missing-active\.csv:2:is_active_version/);
});
```

- [ ] **Step 2: CLI 테스트 미구현 실패 확인**

Run: `node --test scripts/content/validate-content.test.mjs`

Expected: FAIL because CLI and fixtures do not exist.

- [ ] **Step 3: 템플릿과 fixture 작성**

`content/interpretations.template.csv`는 정확한 헤더만 포함한다. `synthetic-test.csv`는 세 카드, 카드당 활성 원문 하나 이상, 한 interpretation의 비활성 version 1과 활성 version 2, 인용된 쉼표·따옴표·여러 줄 본문을 포함한다. 모든 예제 행은 `source_kind=synthetic_test`, `source_attribution=synthetic test fixture`를 사용한다. `invalid-missing-active.csv`는 한 interpretation의 모든 version이 `false`인 의도적 실패 자료다.

- [ ] **Step 4: CLI 구현**

```js
import { readFile } from 'node:fs/promises';
import { validateContentCsv } from './validate.mjs';

const [inputPath, extra] = process.argv.slice(2);
if (!inputPath || extra) {
  console.error('사용법: node scripts/content/validate-content.mjs <csv-file>');
  process.exitCode = 1;
} else {
  // Read a Buffer and decode with new TextDecoder('utf-8', { fatal: true }).
  // Validate without writes, then print every diagnostic and summary.
  // File read failures use the requested path and a bounded error message.
}
```

CLI 테스트에는 잘못된 UTF-8 바이트를 임시 파일에 쓰고 읽기 오류와 exit code 1을 확인하는 사례도 포함한다. 테스트가 만든 파일은 테스트 전용 임시 디렉터리 안에서 정리한다.

성공 보고에는 행·카드·interpretation·활성 후보 수, 카드·locale별 후보 수/바이트, 가장 큰 `ko-KR` 세 카드의 후보 합계, 잔여 바이트, 전체 context 보장 아님, DB 미변경 문구를 포함한다.

- [ ] **Step 5: 작성·검증 안내 작성**

`docs/content/README.md`에 다음 내용을 실제 명령과 예제로 설명한다.

- 템플릿을 복사해 엑셀·구글시트에서 작성하고 UTF-8 CSV로 내보내는 방법
- 각 열의 의미, UUID 유지, 수정 대신 version 행 추가, 활성 버전 선택
- 직접 작성은 `editorial`, 라이선스 원문은 `licensed`, fixture만 `synthetic_test`를 쓰는 규칙
- 쉼표·따옴표·줄바꿈은 스프레드시트의 한 셀 안에 유지하는 방법
- `node scripts/content/validate-content.mjs path/to/file.csv` 실행과 exit code 의미
- 20개/64 KiB 검사의 한계, runtime에서 `ko-KR`만 사용한다는 경고
- 검증 통과가 DB import·활성화를 수행하지 않는다는 경계

- [ ] **Step 6: CLI와 전체 테스트 통과 확인**

Run: `node --test scripts/content/*.test.mjs`

Expected: all tests PASS.

Run: `node scripts/content/validate-content.mjs content/fixtures/synthetic-test.csv`

Expected: exit 0, `검증 통과`, byte summary, and `DB를 변경하지 않았습니다.`

Run: `node scripts/content/validate-content.mjs content/fixtures/invalid-missing-active.csv`

Expected: exit 1 and a diagnostic for `is_active_version`.

- [ ] **Step 7: 전체 산출물 정적 검사**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only files under `content/`, `scripts/content/`, and `docs/content/` are changed.

- [ ] **Step 8: CLI·템플릿·문서 커밋**

```bash
git add content scripts/content docs/content/README.md
git commit -m "docs(content): add authoring workflow"
```
