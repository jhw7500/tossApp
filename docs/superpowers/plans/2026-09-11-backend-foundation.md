# Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track each task with the checkboxes below. Do not commit: repository instructions require explicit user authorization for commits.

**Goal:** 토스 앱 식별자를 연결하고 실제 PostgreSQL을 사용하는 사용자·인연·질문·카드 API를 실행·검증한다.

**Architecture:** 기존 `ai-tarot/` 프런트엔드와 별도 `server/` Node.js API를 둔다. `contracts/`의 JSON Schema를 요청 검증과 타입 도출의 근거로 쓴다. API는 소유권과 세션을 검사하고, SQL migration으로 관리하는 PostgreSQL에 저장한다.

**Tech Stack:** Node.js 24, TypeScript, Fastify 5, pg, JSON Schema, Node test runner, PostgreSQL 18.

**Spec:** [1차 기술 설계서](../specs/2026-09-11-ai-tarot-phase1-design.md), [요청 메일](../../req.txt), [spec.pdf](../../spec.pdf).

## Global Constraints

- 작업 디렉터리: `/home/jhw/ai/opencode/projects/tossApp/.worktrees/backend-foundation`; branch: `feat/backend-foundation`.
- 사용자 지시와 `spec.pdf`가 기준이다. 간이 handoff의 스택·승인 절차는 확정 요구사항이 아니다.
- 앱 이름 `tarororo`, workspace `93125`, miniapp `75257`. 기존 폴더명 `ai-tarot` 유지.
- 이 계획은 설계서 11절의 1~2단계 구현이다. 실제 리딩 생성·worker·AI 공급자 연결·최종 화면은 별도 실행 단위이며 빈 성공 응답으로 대신하지 않는다.
- 세션은 무작위 32바이트 토큰, SHA-256 해시 저장, 30분 만료. 외부 익명 키는 HMAC으로 내부 사용자에 연결한다.
- 실제 식별 검증은 mTLS와 `resultType === 'SUCCESS'`, `success === true || success === 'true'` 모두를 요구한다.
- 개발용 식별은 로컬/테스트와 loopback 바인딩에서만 사용한다. 운영에서 mock 인증은 시작 실패다.
- 별명 필수 1~30 code points, 관계 코드 필수, 상황 선택 최대 2000 code points. 질문·위치·카드는 DB 데이터다.
- 사용자별 저장과 조회를 분리하며 타인 자원은 404, 만료/잘못된 세션은 401, 입력 오류는 400, 낡은 version은 409.
- 모든 shell 명령은 `rtk`로 시작한다. Node 24 명령은 직접 `rtk proxy env PATH="/home/jhw/.nvm/versions/node/v24.12.0/bin:$PATH" ...`를 사용한다.
- 비밀값을 출력하지 않는다. 외부 콘솔 변경, 업로드, 공개 배포, 커밋과 푸시는 이번 실행에 포함하지 않는다.
- 시험 콘텐츠에는 `source_kind=synthetic_test`를 명시한다. 시험 문장을 타로리더가 제공한 원문이라고 표시하지 않는다.
- 기존 untracked 프런트엔드·설계서를 작업공간에 복사한 상태다. 다른 파일의 변경을 되돌리지 않는다.

## Task 1: PostgreSQL 기반 인증·인연·콘텐츠 API

**Files / ownership:**

- Create: `contracts/foundation.schemas.ts` (외부 런타임 의존성 없는 JSON Schema consts).
- Create: `server/package.json`, `server/package-lock.json`, `server/tsconfig.json`, `server/.env.example`, `server/README.md`.
- Create: `server/src/config.ts`, `server/src/app.ts`, `server/src/main.ts`.
- Create: `server/src/auth/{sessions,toss-client}.ts`, `server/src/db/{pool,migrate,seed}.ts`.
- Create: `server/src/routes/{persons,catalogs}.ts`, `server/src/errors.ts`.
- Create: `server/migrations/001_foundation.sql`.
- Create: `server/tests/{config,auth,api,database}.test.ts`, `server/tests/helpers.ts`.
- 더 작은 모듈이 필요한 경우 `server/` 안에서 책임에 따라 나눌 수 있다. `ai-tarot/`와 다른 문서는 수정하지 않는다.

**Interfaces:**

서버의 테스트 진입점은 아래와 같다. 테스트는 이 진입점으로 실제 Fastify 라우트와 실제 PostgreSQL을 통과한다. Toss 네트워크만 검증 함수를 주입해 분리한다.

```typescript
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export interface FoundationConfig {
  environment: 'local' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  authMode: 'mock' | 'toss';
  subjectSecret: string;
  allowedOrigins: string[];
  tossCertPath?: string;
  tossKeyPath?: string;
}

export type VerifyAnonymousKey = (key: string) => Promise<boolean>;
export function buildApp(options: {
  config: FoundationConfig;
  pool: Pool;
  verifyAnonymousKey?: VerifyAnonymousKey;
}): Promise<FastifyInstance>;
export function migrate(pool: Pool): Promise<void>;
export function seedDevelopment(pool: Pool): Promise<void>;
```

`buildApp`은 caller가 전달한 pool을 소유하지 않는다. main이 자신이 만든 pool을 종료한다. migration과 seed 함수는 CLI에서도 호출 가능하게 하되 import 시 실행하지 않는다.

**Schema and storage:**

users, sessions, persons, questions, card_positions, tarot_cards, interpretations, interpretation_versions를 실제 테이블로 구현한다. 설계서와 같은 UUID·UTC 시각·유일 제약·외부 키를 사용한다. Person version은 1부터 시작하며 갱신마다 증가한다. 질문마다 위치 1·2·3을 데이터로 유지한다.

한 카드의 같은 언어에 여러 독립 `interpretations.id`를 허용해야 한다. `interpretation_versions`는 각 원문의 수정 이력이다. 샘플 원문 3개를 하나의 원문에 속한 버전 3개로 대신할 수 없다. 이미 적용한 001의 제약을 고칠 때는 별도 002 migration을 추가하고 기존 원문·수정 이력을 보존한다.

이번 단계의 Person API는 Person의 현재 정보만 반환한다. 아직 생성 기능이 없는 리딩의 건수나 이력을 0으로 하드코딩하지 않는다. 설계서의 리딩 집계 필드는 리딩 모듈을 연결할 때 추가한다. 사용하지 않는 worker·attempt·멱등 키 테이블은 이번 migration에 미리 만들지 않는다.

SQL migration은 트랜잭션, 실행 잠금, 적용 기록과 checksum을 사용한다. 두 번 실행해도 데이터를 지우거나 중복 생성하지 않는다. 적용된 migration의 내용이 달라졌으면 거절한다. 테스트에서만 고유 스키마를 만들고 테스트가 만든 스키마만 정리한다.

seed는 안정적인 UUID로 관계별 추천 질문, custom template, 각 질문의 위치 3개, 샘플 카드 3장과 카드당 시험 원문 3개를 만든다. sample metadata와 출처 표시를 보존하고 두 번 실행해도 원문 버전·사용자 데이터를 덮어쓰지 않는다. 운영 환경의 seed CLI 실행은 거절한다.

기존 seed에 질문이나 원문을 추가해도 이전 레코드의 ID가 바뀌면 안 된다. 빈 DB의 재실행과 기존 샘플 데이터가 있는 DB의 업그레이드를 모두 검증한다.

**API boundary:**

| Method | Path | Contract |
| --- | --- | --- |
| POST | /v1/sessions/toss-anonymous | anonymousKey; 201 token + expiresAt |
| DELETE | /v1/sessions/current | 204; revoke current session |
| POST | /v1/persons | nickname, relationshipCode, currentSituation?; 201 Person |
| GET | /v1/persons | cursor?, limit?; 200 items + nextCursor |
| GET | /v1/persons/:personId | 200 Person or 404 |
| PATCH | /v1/persons/:personId | version + supplied changes; 200 Person |
| GET | /v1/relationship-types | 200 items |
| GET | /v1/questions | relationshipCode; 200 items with 3 positions each |
| GET | /v1/cards | 200 items; selectable card metadata only |
| GET | /health/ready | actual DB probe; 200 or 503 |

Person DTO는 `id, nickname, relationshipCode, currentSituation, version, createdAt, updatedAt`이다. 상황을 입력하지 않으면 null이고, 시각은 ISO 8601 UTC 문자열이다. 내부 userId·익명 키·원문 후보는 응답에 포함하지 않는다.

DTO는 JSON Schema에서 `json-schema-to-ts`의 `FromSchema` 등으로 도출한다. 수동으로 작성한 별도 타입과 이중 관리하지 않는다. Node 24에서 직접 실행할 수 있는 erasable TypeScript와 `.ts` 확장자 import를 사용한다. `contracts/`에는 npm 런타임 의존성을 두지 않는다.

입력의 알 수 없는 필드는 조용히 제거하지 않고 400으로 거절한다. body 상한은 16 KiB, limit 기본값은 20, 최대값은 100이다. 별명은 trim 후 비어 있지 않아야 하며, 상황은 null로 지울 수 있다. PATCH는 최소 한 항목의 변경을 요구하고 version을 조건으로 UPDATE하여 충돌을 감지한다. 다른 소유자의 ID와 존재하지 않는 ID는 같은 404를 반환한다.

cursor는 `createdAt + id`의 base64url 표현을 검증하여 SQL 값 매개변수로 전달한다. 잘못된 cursor는 400이다. created_at과 id의 내림차순으로 조회하며 SQL 값을 문자열로 이어 붙이지 않는다.

Toss 클라이언트는 고정 호스트 `apps-in-toss-api.toss.im`의 POST `/api-partner/v1/apps-in-toss/users/anon-key/verify`만 호출한다. `x-anon-key`와 mTLS cert/key를 지정하고 TLS 인증서 검증을 끄지 않는다. 5초 timeout과 응답 크기 상한을 두고 비200·FAIL·잘못된 JSON을 거절한다. 외부 장애는 503, 정상적으로 검증된 false는 401이다. 키를 로그에 남기지 않는다.

설정은 `APP_ENV, HOST, PORT, DATABASE_URL, AUTH_MODE, AUTH_SUBJECT_SECRET, ALLOWED_ORIGINS, TOSS_MTLS_CERT_PATH, TOSS_MTLS_KEY_PATH`에서 읽는다. secret은 32자 이상이다. production에서는 mock과 loopback origin을 금지하고 HTTPS origin을 요구한다. mock은 local/test와 loopback host 조합만 허용한다. Toss mode에 인증서 설정이 없으면 시작을 거절한다.

CORS는 명시적 allowlist와 필요한 method/header만 허용한다. main의 logger는 authorization과 익명 키 등 민감 값을 가린다. 입력 오류의 body를 로그에 넣지 않는다. 인증 라우트에 제한을 두어 식별 검증 API가 무제한으로 호출되지 않게 한다. 세션 만료·철회를 DB에서 확인하고 401을 반환한다.

**Steps:**

- [x] **1. RED:** Node test runner로 설정·인증과 실제 DB에서의 API 동작을 먼저 정의하고, 필요한 기능이 없어 실패하는 것을 확인한다. 독립적으로 정한 기대값 예시:

```typescript
const created = await app.inject({
  method: 'POST', url: '/v1/persons',
  headers: { authorization: `Bearer ${aliceToken}` },
  payload: { nickname: '민지', relationshipCode: 'crush' },
});
assert.equal(created.statusCode, 201);
const person = created.json();
assert.equal(person.nickname, '민지');
assert.equal(person.version, 1);
assert.equal(person.currentSituation, null);
const forbidden = await app.inject({
  method: 'GET', url: `/v1/persons/${person.id}`,
  headers: { authorization: `Bearer ${bobToken}` },
});
assert.equal(forbidden.statusCode, 404);
```

- [x] **2. Storage:** migration runner·스키마·seed·DB 격리 test helper를 구현하고 재적용·FK·unique·원문 1:N을 실제 DB로 검증한다.
- [x] **3. GREEN:** 세션·소유권·Person 수정·catalog·스키마 검증을 구현하여 테스트를 통과시킨다. 기대값을 구현에 맞춰 느슨하게 바꾸지 않는다.
- [x] **4. Failure coverage:** 만료/철회 token, 알 수 없는 필드, 빈 별명, 잘못된 관계, version 충돌, 잘못된 cursor, 여러 page, 타인의 PATCH, Toss false/문자열 false/FAIL/잘못된 응답, 운영 mock 거절을 검증한다.
- [x] **5. Verify:** `npm run typecheck`, `npm test`, `npm run test:integration`을 실행한다. integration은 `TEST_DATABASE_URL`이 필요하며, 미설정이면 명확히 실패해야 한다.
- [x] **6. Document:** `server/README.md`에 Node24, Docker 기반 로컬 PostgreSQL, .env, migration, seed, 시작, 테스트, 실제 Toss 검증의 전제를 적는다. 비밀값이나 실제로 수행하지 않은 실기기 검증 결과를 기록하지 않는다.

스크립트는 `start`, `dev`, `typecheck`, `test`, `test:integration`, `db:migrate`, `db:seed`를 제공한다. 실제 DB를 사용하는 integration과 외부 자격 증명이 필요 없는 unit을 분리한다. 필요한 패키지만 도입하고 lockfile을 만든다.

## Task 2: tarororo 설정 연결과 검증 결과 반영

**Files:**

- Modify: `ai-tarot/apps-in-toss.config.ts`, `ai-tarot/README.md`, `ai-tarot/AGENTS.md`.
- Modify: this plan's checkboxes with actual completion evidence.

**Interfaces:** appName `tarororo`; expected bundle `tarororo.ait`; Task 1 server commands from `server/README.md`.

- [x] **1. Connect:** config의 `appName: 'ai-tarot'`을 `appName: 'tarororo'`로 바꾼다. 패키지명·디자인·permissions는 유지한다.

```typescript
export default defineConfig({
  appName: 'tarororo',
  brand: { primaryColor: '#3182F6' },
  permissions: [],
  webBundleDir: 'dist',
});
```

- [x] **2. Docs:** README에 tarororo.ait와 등록된 ID를 반영하고 server README를 연결한다. AGENTS의 개발용 appName 설명을 현황에 맞춘다. API 구현과 프런트엔드 Person 화면·AI 기능을 구분한다.
- [x] **3. Verify:** frontend에서 `npm run typecheck`, `npm run lint`, `npm run build`를 실행한다. 새 번들의 존재와 빌드 로그의 appName을 확인한다. 설정값 일치 여부만 보는 테스트는 추가하지 않는다.
- [x] **4. Smoke:** 실제 HTTP 서버에서 health, 세션 발급, Person 생성·수정·재조회, 다른 사용자 404, catalog 목록을 확인한다. DB 재접속 후에도 저장한 데이터를 조회할 수 있어야 한다.
- [x] **5. Review:** 작업별·전체 검토의 중요한 지적을 해결하고, 실행한 검사와 남아 있는 실제 Toss·AI 단계를 보고한다.

## Evidence and scope

이번 단계의 합격 증거는 실제 PostgreSQL을 통과한 사용자 분리·영속성·콘텐츠 조회, 검증 가능한 실제 HTTP API와 `tarororo.ait` 빌드다. 리딩 생성과 AI 시험은 이 계획의 완료라고 표시하지 않는다. 커밋·공개 배포 없이 작업공간의 파일과 검증 결과를 전달한다.

검증 완료: 서버 타입 검사, 단위 테스트 8개, 실제 PostgreSQL 통합 테스트 9개가 통과했다. 실제 HTTP 서버의 생성·수정·소유권 검사와 재시작 후 세션·인연 보존을 확인했다. 기존 DB를 초기화하지 않고 새 migration과 seed를 적용했으며, 카드별 독립 원문 3개와 이전 수정 이력을 보존했다. 프런트엔드 타입 검사·린트·빌드가 통과했고 `ai-tarot/tarororo.ait`를 생성했다. 기존 TDS 템플릿의 Vite 청크 크기 경고는 남아 있다. 최종 검토에서 미해결 지적이 없다.

실행 방법은 [서버 README](../../../server/README.md)와 [프런트엔드 README](../../../ai-tarot/README.md)에 있다. 구현 작업공간은 위 Global Constraints의 worktree이며, 실제 토스 mTLS 인증·실기기 검증과 인연 화면·AI 리딩 연결은 후속 단계다.
