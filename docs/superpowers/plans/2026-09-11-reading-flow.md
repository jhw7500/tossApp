# Reading Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Track the live checkboxes in this plan; the controller owns progress updates. Do not commit, push, merge, upload, or deploy.

**Goal:** 인연 입력에서 추천/직접 질문·서로 다른 카드 3장 선택, 원문에 근거한 AI JSON 생성, 리딩 저장·재조회까지 실행한다.

**Architecture:** 기존 PostgreSQL API에 리딩 스냅샷과 실행 대기열을 추가한다. 별도 worker가 짧은 DB claim 후 외부 AI를 호출하고, 구조·근거를 검증한 결과를 원자적으로 저장한다. React/TDS 검증용 화면은 같은 API 계약을 사용한다.

**Tech Stack:** 기존 Node 24.12+, TypeScript, Fastify 5, PostgreSQL 18, React 18, Vite, TDS. AI 어댑터는 Node fetch로 구현하며 Gemini 모델은 환경 설정으로 선택한다. 출력 JSON 검증에는 기존 Fastify가 사용하는 Ajv를 직접 의존성으로 선언할 수 있다.

**Spec:** [기술 설계](../specs/2026-09-11-ai-tarot-phase1-design.md) 5~8·11절, [요청 메일](../../req.txt), [spec.pdf](../../spec.pdf) 3~11·13·18·20쪽.

## Global Constraints

- 작업공간: `/home/jhw/ai/opencode/projects/tossApp/.worktrees/backend-foundation`, 기존 `feat/backend-foundation` branch. 이전 기반 작업은 보존한다. 모든 shell 명령은 `rtk`로 시작한다.
- Node 명령: `rtk proxy env PATH="/home/jhw/.nvm/versions/node/v24.12.0/bin:$PATH" ...`. 기존 `server/.env`는 읽어 사용할 수 있으나 비밀값을 출력하거나 snapshot/review에 넣지 않는다.
- 사용자 지시와 req/spec가 기준이며 handoff는 참고만 한다. 현재 `go`는 승인된 설계의 리딩·화면 연결을 진행하라는 지시다. Task/Issue/등록 선택은 이미 결정됐으므로 반복하지 않는다.
- 001·002 migration은 변경하지 않는다. 기존 DB를 초기화하지 않고 003 이후 migration으로 확장한다. 단위 테스트는 외부 네트워크 없이, 통합 테스트는 고유 PostgreSQL 스키마에서 수행한다.
- 카드 하나의 여러 Interpretation은 서로 다른 원문 ID다. InterpretationVersion은 각 원문의 수정 이력이다. 활성 원문과 정확한 버전을 스냅샷에 보존한다.
- AI는 공급된 원문의 뜻을 선별·조합·문장화한다. 일반 지식으로 카드 의미를 보충하거나 뒤집는 fallback을 두지 않는다. 시험 데이터는 `synthetic_test`이며 리더 원문 품질 합격으로 주장하지 않는다.
- UI·카드 연출·브랜드 최종안, 78장 전체 콘텐츠, RAG·Vector DB·결제·광고는 이번 구현 대상이 아니다. 화면은 기능 검증용이며 자체 타이틀, 임시 중립색, 시스템 서체와 기존 TDS를 사용한다.
- 앱 `tarororo`, workspace `tarotaro`/93125, miniapp 75257. 기존 앱인토스 SDK 3.2.0과 폴더 `ai-tarot`을 유지한다. 새 상단 네비게이션을 그리지 않는다.
- 비밀키는 서버/worker 환경에서만 읽는다. API token은 프런트엔드 메모리에만 둔다. 실제 SDK 실패를 개발용 공용 사용자로 대체하지 않는다.
- 선택적 공급자 질문에 다른 답이 오면 반영한다. 현재 Gemini key의 존재와 공식 모델 목록 접근만 확인했으며 초기 검증 모델은 `gemini-3.1-flash-lite`로 제안한다. 최종 사업 모델 선정은 아니다.

## Task 1: 리딩 스냅샷·대기열·조회 API

**Ownership / files:**

- Create `contracts/reading.schemas.ts` (요청·응답·AI 결과·내부 context schema와 도출 타입의 근거).
- Create `server/migrations/003_reading_flow.sql`.
- Create `server/src/readings/{types,constants,snapshot,store,attempts}.ts`, `server/src/routes/readings.ts`. 책임에 따라 같은 디렉터리 안에서 더 작은 모듈로 나눌 수 있다.
- Modify `server/src/app.ts`, `server/src/errors.ts`, `server/src/routes/{persons,catalogs}.ts`, `server/src/db/seed.ts`, `contracts/foundation.schemas.ts`, `server/package.json`, `server/README.md`.
- Create behavior tests `server/tests/readings.test.ts`, `server/tests/reading-attempts.test.ts`; extend 기존 helper/DB 테스트는 변경의 검증에 필요한 범위만.
- 프런트엔드나 AI 어댑터/worker 코드는 이 Task에서 수정하지 않는다.

**Data:**

003은 persons에 `(id,user_id)` unique를 추가하고 readings가 복합 FK로 동일 소유자를 강제하도록 한다. questions에 version과 활성 상태를, interpretations에 활성 상태와 active_version을 추가한다. 기존 원문의 활성 버전은 현재 마지막 버전으로 보존한다. 신규 seed도 활성 버전을 명시하고 재실행 시 기존 활성 선택을 덮어쓰지 않는다. 원문 후보가 여러 개인 구조를 유지한다. 활성 버전은 `(interpretation_id,version)` 참조로 유효성을 보장한다.

질문 내용·관계·custom 여부와 위치의 변경은 질문 version을 올려야 한다. 작은 DB trigger 또는 단일 변경 경계를 통해 조용한 변경이 없도록 하고 실제 DB로 검증한다. 현재 콘텐츠 관리 UI는 추가하지 않는다. 원문 수정은 새 version 추가 후 active_version 전환으로 한다.

추가 테이블: readings, reading_cards, reading_evidence, reading_attempts, idempotency_requests. Reading의 입력 JSON은 Person ID/version/별명/관계/상황, 질문 ID/version/최종 자유문 여부·본문, 위치 3개의 라벨·설명, 카드 메타데이터와 후보 원문 ID/version/본문/출처를 보존한다. reading_cards는 한 Reading에서 카드와 위치가 각각 유일하다. reading_evidence는 정확한 원문 버전에 FK를 두고 후보/선택 여부를 보존한다. 사용자 공개 DTO에 후보 원문 전체·prompt·실행 lease·비밀값을 넣지 않는다.

한 user의 QUEUED/RUNNING Reading은 최대 1개, 한 Reading의 QUEUED/RUNNING attempt는 최대 1개다. PostgreSQL 부분 unique index로 보장한다. idempotency key는 `(user_id,operation,key)` unique이며 Reading과 해당 요청의 attempt ID를 가리킨다. 시간 기반 정렬 cursor는 PostgreSQL의 microsecond 정밀도를 잃지 않는다.

**Frozen HTTP contracts:**

기존 Person DTO에 실제 성공 리딩 집계 `readingCount: integer`, `lastReadingAt: string|null`을 추가한다. 조회·생성·수정 DTO가 일관돼야 하며 성공 기록만 집계한다. 질문 catalog에는 `version`, `positions[].position/label/description`을 제공한다. 추천 관계에 맞는 질문과 활성 custom template를 함께 조회할 수 있게 하며 custom 질문은 모든 관계에서 사용할 수 있다. 카드는 읽을 수 있는 활성 원문이 있는 것만 선택 가능 목록에 포함한다.

```typescript
// POST /v1/readings; required Idempotency-Key: UUID
type CreateReadingBody = {
  personId: string;
  personVersion: number;
  question: { id: string; version: number; customText?: string };
  selections: Array<{ positionIndex: number; cardId: string }>;
};
// POST /v1/readings/:readingId/retry; required Idempotency-Key: UUID
type RetryReadingBody = { expectedAttemptNo: number };
type AcceptedReading = {
  readingId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  attemptNo: number;
  statusUrl: string;
};
```

첫 접수는 202, 같은 key/같은 정규화 요청의 재전송은 200, 다른 요청은 409 `IDEMPOTENCY_CONFLICT`. UUID는 정규화하고 selections는 위치 순으로, customText는 trim 후 hash한다. replay는 현재 Person/콘텐츠 version 검사보다 먼저 처리하며 기존 스냅샷을 바꾸지 않는다. replay의 attemptNo/status는 key가 참조하는 attempt이고 statusUrl은 현재 Reading 조회 주소다. 동시 동일 key도 한 Reading/attempt만 만든다.

GET `/v1/readings/:readingId`의 DTO는 `{id,personId,status,attemptNo,createdAt,updatedAt,input,result,error,aiGenerated,testContent}`다. input은 `{personNickname,relationshipCode,currentSituation,question:{id,version,text,isCustom},cards:[{cardId,name,positionIndex,label}]}`의 공개 요약이다. result는 성공한 ReadingResult 또는 null, error는 `{code,message,retryable}` 또는 null이다. `aiGenerated`는 서버가 실제 AI 결과에만 true로 표시하고 `testContent`는 시험 원문 사용 여부다.

GET `/v1/persons/:personId/readings?cursor&limit`은 `{items,nextCursor}`이며 item은 `{id,status,question,summary,createdAt}`다. 기본20/최대100, 최신순. 없는/타인 Person 또는 Reading은 404, 세션 없음401이다.

입력의 unknown body/query/params를 거절한다. 서로 다른 카드 3장과 위치 1·2·3을 요구한다. Person/질문 version 불일치는409 `STALE_VERSION`, 비활성/원문부족/위치부족은422 `CONTENT_UNAVAILABLE`, 사용자 활성 Reading 제한은429 `RATE_LIMITED`. customText는 custom template에만 필수이며 trim 후1~500 code points다. 추천 질문에서는 customText를 금지한다. 카드당 활성 원문 최대20개, 전체 context 직렬화 최대64KiB로 두고 초과 시422 `CONTENT_CONTEXT_LIMIT`; 임의로 잘라내지 않는다. production에서는 synthetic_test를 근거로 사용할 수 없다.

오류 응답은 기존 `{error:{code,message}}`에 `retryable:boolean`, `requestId:string`을 추가한다. 내부/공급자 오류 본문을 노출하지 않고 기존 상태코드는 보존한다. CORS에 Idempotency-Key를 허용한다.

**Worker-facing interface (Task 2 consumer):**

인터페이스는 같은 의미를 유지하되 types 모듈에서 정확한 타입을 export하고 report에 실제 import 경로를 적는다.

```typescript
type ReadingClaim = {
  readingId: string; attemptId: string; attemptNo: number;
  snapshot: ReadingSnapshot; promptVersion: string; contractVersion: string;
  leaseExpiresAt: string;
};
claimNextReading(pool, { provider, model }): Promise<ReadingClaim | null>;
completeReading(pool, claim, { result, usage, aiGenerated }): Promise<boolean>;
failReading(pool, claim, { code, message, retryable }): Promise<boolean>;
expireReadings(pool): Promise<number>;
```

상태는 QUEUED -> RUNNING -> SUCCEEDED/FAILED, 명시적 retry만 같은 Reading의 다음 attempt를 만든다. 최대3 attempts, queue60초, lease45초다. 숫자·contract/prompt version은 constants에서 공유한다: `reading-result.v1`, `tarot-grounded.v1`.

새 요청/retry는 user 잠금으로 직렬화하고, Reading/attempt를 만지는 모든 경로는 Reading -> attempt 순서로 잠근다. claim은 `FOR UPDATE SKIP LOCKED`로 짧게 확보한다. 외부 호출 중 DB lock을 유지하지 않는다. 만료된 QUEUED는 QUEUE_TIMEOUT, RUNNING은 WORKER_TIMEOUT으로 FAILED. API 조회/재시도에서도 대상 만료 상태를 정리할 수 있어 worker 중단 시 영구 대기로 남지 않는다.

complete/fail은 현재 attempt·RUNNING·유효 lease를 모두 검사하며 늦은 결과는 false를 반환하고 덮어쓰지 않는다. 결과와 선택 근거, attempt/Reading 성공은 하나의 transaction이다. 모든 evidence 쌍이 저장된 후보와 해당 카드/위치에 속하는지 저장 직전에도 검증한다. retryable이 false이거나 성공/진행중/3회 소진 상태의 retry는409 `RETRY_NOT_ALLOWED`. 자동 AI 재호출을 수행하지 않는다.

**Steps / evidence:**

- [x] RED: 기존 API에 새 경로 호출 시 실패하는 행동 테스트부터 작성한다. 실패 이유를 확인한 다음 구현한다.
- [x] Migration/snapshot: 기존 데이터 보존, independent source+active version, source/Person/질문 변경 후 기존 snapshot 불변, 정확한 source FK와 소유자 FK를 실제 PG로 검증한다.
- [x] API/idempotency: 추천/custom 성공 입력, 잘못된 위치·중복 카드·빈 질문·다른 사용자·낡은 version·원문 없음·unknown 입력·재전송·동시 동일 key·다른 key 활성 제한·목록 cursor를 검증한다.
- [x] Attempts: 두 동시 worker claim, 만료·retry·최대3회·늦은 이전 결과 거절·선택 근거 저장·성공 후 Person 집계·DB 재접속을 실제 PG에서 검증한다. 시간 경과는 테스트 소유 행의 시각 조정으로 재현하고 긴 sleep을 쓰지 않는다.
- [x] Typecheck와 관련 unit/integration을 실행하고 README/API 계약과 report를 갱신한다. 테스트에서 외부 AI를 호출하지 않는다.

## Task 2: Gemini 어댑터·근거 검증·독립 worker

**Ownership / files:** Create `server/src/ai/{types,config,context,prompt,validate,gemini}.ts`, `server/src/worker/{run,main}.ts`, `server/tests/{reading-ai,reading-worker}.test.ts`. Modify server scripts/lockfile/env.example/README 및 필요한 Task1 경계만. 프런트엔드는 수정하지 않는다.

**Contract:** `ReadingResult`는 shared schema로 도출한다. `{cards:[{positionIndex,cardId,text,evidence:[{interpretationId,version}]}],overallReading,summary}`. cards 정확히3, text1~800codepoints, overall1~2000, summary1~120. unknown fields 거절. 각 위치/카드가 입력과 같고 모든 evidence가 그 카드에 공급한 ID/version이어야 하며 중복·누락을 거절한다. AI가 서버 상태/aiGenerated/provider 등을 정할 수 없다.

`ReadingContext`에는 관계·상황·질문·위치·카드·후보 원문만 포함한다. userId/personId/별명/세션/익명키를 넘기지 않는다. prompt `tarot-grounded.v1`은 서버 system instruction이며 자유문은 JSON data로 별도 전달한다. 후보 밖 지식 추가·원문 의미 반전·절대적 예언을 금지하고 3장 종합 흐름을 요청한다. 알 수 없는 prompt/contract version에는 latest fallback을 하지 않는다.

설정: `AI_PROVIDER=gemini`, `AI_MODEL=gemini-3.1-flash-lite`, `GEMINI_API_KEY`. 키는 worker process 환경에서 읽으며 사용자 env 파일을 임의 수정하지 않는다. 공식 API endpoint를 고정하고 user supplied URL을 허용하지 않는다. Node fetch는 redirect를 거절하고 전체20초 timeout/응답256KiB 상한/출력 token 상한을 둔다. 자동 재시도 없음. HTTP429/5xx/네트워크/timeout은 안전한 retryable 실패, 인증·설정/거절은 non-retryable, JSON/근거 오류는 `AI_OUTPUT_INVALID` 실패다. refusal/빈 결과/잘림/예상하지 않은 finishReason을 성공으로 저장하지 않는다. usage는 허용한 수치만 저장한다.

Provider는 주입 가능한 인터페이스이며 로컬 테스트용 fixture 구현은 테스트 도구 안에 둔다. 실제 worker main에서 fixture를 기본값으로 쓰지 않는다. worker는 외부 호출 없는 단위/통합 테스트에서 의존성 주입으로 실행한다. 모델 변경은 env로 가능하며 새로운 API형식 차이는 명시적으로 지원/실패해야 한다.

`runWorker({pool,provider,signal,concurrency?})` 또는 동등 진입점은 최대2개를 처리하고 중지 시 신규 claim을 멈춘다. SIGINT/SIGTERM은 pending fetch를 abort하고 DB pool을 정리한다. idle poll은 짧은 취소 가능한 timer이며 테스트에서 긴 대기를 강요하지 않는다. expiry sweep, claim, context/prompt/JSON validate, conditional complete/fail 순서로 동작한다. provider/model은 claim 때 실제 attempt에 기록하고, 한 attempt에서 provider를 한 번만 호출한다.

- [x] RED: 유효한 근거 결과·다른 카드 근거/잘못된 버전/중복 위치/초과 길이·빈/refusal/malformed/truncated 응답을 행동 테스트로 먼저 정의한다.
- [x] Gemini adapter: 공식 문서의 REST 형식을 확인해 구현하고 실제 transport의 async 오류/timeout/응답 상한도 zero-network 시험으로 검증한다. 키나 원문을 로그에 남기지 않는다.
- [x] Worker: 실제PG+주입 provider로 성공, 지연/취소, 실패, 수동retry, 이미 만료된 이전attempt의 늦은완료, process재시작 후 queue복구/lease종료를 검증한다. 숨은 provider 재시도가 없는지 확인한다.
- [x] 타입 검사와 관련unit/integration 검증, env/scripts/README를 갱신한다. 실제 Gemini 생성 smoke는 controller가 별도 기록하며 테스트 suite의 필수 네트워크 의존성으로 만들지 않는다.

## Task 3: 인연·리딩 검증용 화면과 브라우저 흐름

**Ownership / files:** Modify `ai-tarot/src/{App.tsx,App.css,index.css}`, `ai-tarot/apps-in-toss.config.ts`, `ai-tarot/vite.config.ts`, README/AGENTS (기존 design-guide block 보존). Create `ai-tarot/src/api/{client,types}.ts`, 작은 `pages/`, `hooks/` 또는 feature별 모듈, `.env.example` 및 필요한 행동 테스트. 서버/contract 변경은 필요한 연결 결함을 구체적으로 보고하고 controller와 조정한다.

**Screens / behavior:**

1. 인연 목록: loading/error/empty, 새 인연 CTA, 누적 성공 리딩과 마지막 날짜.
2. 인연 입력·수정: 별명/관계 필수, 상황 선택; 입력 보존, 중복 전송 방지, 409 충돌 안내 후 최신 데이터 다시 읽기.
3. 인연 상세: 현재 정보, 이전 기록, 새 리딩 시작. 과거 결과에는 현재 수정된 정보를 덮어쓰지 않는다.
4. 질문·카드 폼: DB 추천/custom template와 정확한 version 사용, 직접 질문500자, 위치별로 서로 다른 카드3장 선택. 카드 역할 라벨은 DB 값이다. 최종 카드 연출은 추가하지 않는다.
5. 생성 상태·결과: QUEUED/RUNNING을 약2초 간격으로 조회하고 terminal/unmount에서 중지. 카드별 해석3개·종합·요약, AI 표시와 시험 원문 표시. 실패는 결과로 꾸미지 않으며 retryable/attempt 수에 따라 명시적 retry CTA. 과거 기록 재조회와 브라우저 재진입을 지원한다.

클라이언트는 실제 SDK `User.getAnonymousKey()` 반환 타입을 공식 문서/설치 타입으로 확인한다. 실제 모드에서 SDK오류를 mock key로 대체하지 않는다. 개발용 key는 `import.meta.env.DEV && VITE_LOCAL_MOCK_AUTH==='true'`에서만 사용하고 브라우저별 UUID를 생성해 유지한다. 실제 session token은 메모리에만 보관하고401시 최대1회 재식별 후 원래 요청/key를 유지해 재시도한다.

`VITE_API_BASE_URL`은 공개 설정이다. local은 Vite `/api` proxy로127.0.0.1:3100에 연결할 수 있다. production은 명시적 HTTPS API URL이 없으면 안전한 연결오류 화면을 보이고 local/mock으로 fallback하지 않는다. generated bundle에 개발 key·provider secret·서버.env 값이 포함되지 않아야 한다.

생성/retry마다 Idempotency-Key를 만들고 네트워크 실패의 재전송에는 같은key/body를 유지한다. 접수 응답 전에 페이지가 새로고침돼도 중복 생성하지 않도록 최소 pending request를 sessionStorage에 보존하고 확인 후 지운다. 현재 Reading은 URL/history 또는 비밀 없는 재진입 포인터로 복구한다. token은 저장하지 않는다. History API/플랫폼 swipe-back 동작을 보존하며 자체 상단 back/nav를 겹쳐 만들지 않는다.

화면은 기존 TDSMobileAITProvider와 컴포넌트를 사용한다. `ait:design` references와 프로젝트 design guide를 읽는다. brand checkpoint: 공식 starter 로고·링크를 실제 흐름으로 교체하며 자체 타이틀 `tarororo`, 임시중립 `#4B5563`, 시스템서체를 쓴다. 최종 브랜드 결정이 아니다. body15px 이상·44px터치·하단34px이상 및실제safe-area·한글keep-all·가로넘침없음·텍스트로꺾쇠아이콘금지. 이모지 자산을 추가하지 않는다. 컨테이너 관련근거는 최신 docs MCP로 확인한다.

- [x] RED: API client의401 재식별·key유지·오류상태·생성폼 중복선택/필수값을 테스트하거나 browser E2E의 실패단계로 먼저 정의한다. 새테스트도구 설치가 필요하면 기존 로컬 Playwright를 우선 확인한다.
- [x] 실제 API를 호출하는 화면과상태를 구현한다. 성공결과를 프런트엔드상수로 대신하지 않는다.
- [x] typecheck/lint/build, tarororo.ait 생성,secret 없는productionbundle을 확인한다.
- [x] 실제브라우저+PG+worker로 인연생성·수정·질문·카드선택·생성·기록재조회·새로고침·실패/재시도·중복요청을 검증한다.320/390/480px viewport에서 safe-area/가로넘침/터치타깃을 확인하고 G0~G8판정을 report에 남긴다.
- [x] README/AGENTS와검증보고서를 갱신한다. controller가 실제Gemini 결과를 저장/재조회하고 전체검토를 완료한다. 실기기와리더원문충실도는 수행한증거 없이 완료표시하지 않는다.

## Acceptance evidence

실제 PG에 저장된 원문 스냅샷과 기록, 재전송/동시성/worker중단 처리, 주입 provider 테스트, 실제 Gemini의 구조화된 결과를 저장·재조회한 증거, 브라우저 기능 흐름과 bundle이 필요하다. 실제 Toss mTLS·HTTPS 호스팅·기기 검증이나 리더 원문이 준비되지 않았다면 해당 외부검증은 구분해 보고하고 실행 가능한 코드와 로컬검증을 끝까지 완성한다.
