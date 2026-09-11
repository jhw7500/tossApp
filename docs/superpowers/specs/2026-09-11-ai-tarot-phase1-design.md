# AI 타로 1차 개발 기술 설계

작성일: 2026-09-11. 상태: 구현 전 검토용 초안. 대상: `tarororo` 미니앱의 디자인 전 선행 개발.

## 1. 근거와 현재 상태

기능 범위와 완료 기준은 사용자 지시, [spec.pdf](../../spec.pdf) v0.1, [req.txt](../../req.txt)를 따른다. [간이 handoff](../../ai-tarot-cli-handoff.md)는 기술 아이디어 참고 자료다. 아래의 서버 구성, 세션 수명, 재시도 횟수 등은 이번 설계의 제안이며 원래 기획서의 확정 요구사항과 구분한다.

2026-09-11 확인한 상태는 다음과 같다.

| Item | Observed value |
| --- | --- |
| Workspace | tarotaro / 93125 |
| Miniapp | tarororo / 75257 |
| Console status | PREPARE; not released |
| Console MCP | authenticated; read access verified |
| Frontend | React 18 / TypeScript / Vite / TDS |
| SDK | @apps-in-toss/web-framework 3.2.0 |
| Local runtime | Node.js 24.12.0 |
| Local appName | ai-tarot; alignment pending |
| Backend / DB / AI engine | not implemented |
| Device end-to-end test | not completed |

로컬 화면은 공식 시작 템플릿이다. 앞서 로컬 타입 검사·lint·빌드를 통과했지만, 이번 문서 작성에서는 애플리케이션 검사를 다시 실행하지 않았다. 콘솔 등록과 로컬 빌드만으로 실제 토스 앱 동작까지 검증된 것은 아니다.

## 2. 이번 개발의 범위와 완료 기준

사양서 13·20쪽의 1차 목표를 한 흐름으로 구현한다.

```text
Identify User -> Create Person -> Select Question + 3 Cards
              -> Load Interpretations -> Generate AI JSON
              -> Save Reading -> Reload Person History
```

현재 구현 범위는 사용자 식별, 인연 등록·수정·조회, 추천/직접 질문, 질문별 카드 위치 3개, 카드별 복수 원문 해석, AI 결과 생성, 리딩 저장·재조회다. 테스트용 폼에서 사용자가 서로 다른 카드 3장을 고를 수 있게 한다.

샘플 카드 3~5장과 카드당 원문 해석 3~5개로 검증한다. 카드 선택·뒤집기 최종 UI, 브랜드 자산, 78장 전체 콘텐츠, 최종 분류 체계, 정방향/역방향 정책, 유료 상품과 무료 횟수는 사양서가 지정한 후속 단계에서 결정한다. 선택 카드의 `orientation`은 초기 입력과 프롬프트에서 사용하지 않는다. 이를 정방향 정책의 확정으로 해석하지 않는다.

완료 증거는 두 단계로 남긴다. 로컬에서 실제 PostgreSQL과 AI 공급자를 연결한 엔진 검증을 먼저 하고, 토스 QR 테스트에서 실제 사용자 식별과 재접속 후 기록 조회까지 확인한다. mock만 사용한 검사는 첫 번째 단계의 부분 검증으로 표시한다.

## 3. 구성 대안과 권장안

| Approach | Strength | Cost / constraint | Decision |
| --- | --- | --- | --- |
| Node.js API + PostgreSQL | Shared TS; explicit transactions; portable hosting | API and worker operations | Recommended |
| Managed backend + hosted functions | Less initial infrastructure work | Runtime, mTLS and job lifecycle checks | Alternative |
| Local API + SQLite | Small local prototype | PostgreSQL and device integration still needed | Test-only alternative |

권장안은 **Node.js 24 + TypeScript + Fastify 5 + PostgreSQL**이다. 기존 프런트엔드 언어를 이어 쓰고, 리딩·원문 버전·실행 상태를 한 트랜잭션으로 관리하기 쉽다. 호스팅 업체는 이 구조를 지원하는 환경 중에서 선택한다. PostgreSQL의 지원 중인 메이저 버전과 패키지의 정확한 버전은 구현 시 lockfile과 실행 환경에 고정한다.

HTTP 요청·응답은 저장소의 JSON Schema로 정의하고 TypeScript 타입을 이 계약에서 도출한다. Fastify의 요청 검증과 응답 스키마 기능을 사용하되, AI 출력은 저장 전에 별도 검증한다. 사용자 입력으로 스키마를 만들지 않는다. [Fastify 공식 문서](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)

DB 접근은 매개변수 SQL과 순서가 있는 SQL migration을 기준으로 한다. 도메인 로직을 HTTP 프레임워크나 특정 AI SDK에 넣지 않는다. 최초 구축에 Redis, Vector DB, RAG, 마이크로서비스 분리는 필요하지 않다.

```text
Toss WebView / React
  | HTTPS + service session
  v
Node.js API --------------------------> Toss API
  |                                      mTLS / anon-key verification
  v
PostgreSQL <------ Reading Worker ----> AI Provider
  |                   |
  +-- Content         +-- Prompt / JSON / evidence validation
  +-- Readings
  +-- Attempts
```

API와 worker는 같은 서버 코드와 DB를 사용하는 실행 단위다. 초기에는 같은 호스트에서 실행할 수 있다. worker가 HTTP 응답 종료 후에도 동작해야 하므로, 호스팅은 지속 실행 프로세스를 지원해야 한다. 요청 종료와 함께 실행이 중단되는 함수 환경을 선택하면 작업 실행 부분을 해당 환경의 지속성 있는 작업 서비스로 바꿔야 한다.

구현 시 기존 프런트엔드 디렉터리를 유지하고 아래 경계로 추가한다. 이 문서 작성으로 해당 디렉터리나 패키지가 생성된 것은 아니다.

```text
tossApp/
|-- ai-tarot/                 # existing frontend
|-- contracts/               # JSON schemas; generated TS types
|-- server/
|   |-- src/http/            # routes, auth, request validation
|   |-- src/domain/          # persons, questions, readings
|   |-- src/adapters/        # PostgreSQL, Toss, AI provider
|   |-- src/worker/          # claim, generate, validate, persist
|   |-- migrations/          # ordered SQL
|   |-- fixtures/            # isolated test content
|   `-- tests/               # Node test runner
`-- docs/superpowers/specs/
```

## 4. 사용자 식별과 접근 제어

비게임 앱인 `tarororo`는 SDK의 `User.getAnonymousKey()`를 초기 식별 방식으로 사용한다. 공식 문서는 같은 미니앱과 같은 사용자에게 기기 변경 후에도 동일한 키가 반환된다고 설명한다. SDK 함수는 별도 로그인 화면 없이 사용할 수 있고, 실제 키 동작은 QR 테스트로 확인해야 한다. [사용자 식별키 가이드](https://developers-apps-in-toss.toss.im/documentation/common/authentication/hash-key), [SDK 3.x API](https://developers-apps-in-toss.toss.im/documentation/sdk/domains-api/user/user.getanonymouskey)

클라이언트가 전송한 키를 바로 내부 `userId`로 신뢰하지 않는다.

```text
SDK -> anon key -> POST /v1/sessions/toss-anonymous
                         |
                         v
                 Toss verification via mTLS
                         |
                         v
                 internal User + random session
                         |
                         v
                 owner-scoped API requests
```

서버는 `POST /api-partner/v1/apps-in-toss/users/anon-key/verify`에 `x-anon-key`를 보내 검증한다. 미니앱은 클라이언트 인증서로 식별된다. HTTP 200이어도 `resultType`이 실패이면 거절한다. [식별키 검증 API](https://developers-apps-in-toss.toss.im/api/user-key)

공식 자료에 응답 형식 차이가 있다. API OpenAPI는 `success: true`를, 기능 가이드는 `success: "true"`를 예시로 든다. Toss 어댑터는 `resultType === "SUCCESS"`와 함께 **boolean `true` 또는 정확한 문자열 `"true"`만** 성공으로 정규화한다. `false`, `"false"`, 다른 문자열·객체는 실패다. 두 문서 형태를 계약 테스트에 넣고 실기기 응답으로 확인한다.

검증 후에는 내부 UUID 사용자를 찾거나 만든다. 외부 키는 서버 비밀값을 사용하는 HMAC으로 바꿔 `provider + app_name + subject_digest`의 유일 키로 보존한다. 원래 키를 로그·URL·분석 이벤트에 남기지 않는다. HMAC 비밀값은 재시작 후에도 유지하며, 교체 시 기존 키 버전으로 조회한 뒤 새 버전으로 전환한다.

서비스 세션은 암호학적 난수 32바이트로 발급하고 DB에는 토큰의 SHA-256 해시만 저장한다. 제안 만료 시간은 30분이다. 클라이언트는 세션을 메모리에 두고 `Authorization: Bearer`로 전송한다. 앱 재진입·만료 시 SDK 키 검증을 다시 거친다. 장기 refresh token은 초기 범위에 넣지 않는다.

모든 Person·Reading 접근은 세션의 내부 `userId`로 소유권을 검사한다. 요청 body의 `userId`는 허용하지 않는다. 다른 사용자 자원과 없는 자원은 모두 404로 응답한다. CORS는 이 접근 제어를 대신하지 않는다.

개발용 식별 어댑터는 별도 로컬 환경과 개발 DB에서만 실행한다. 공개 개발 서버와 QR 테스트는 실제 식별 검증을 사용한다. 운영 모드에서 mock 인증이 켜져 있으면 시작을 거부한다. SDK 오류·카테고리 오류·미지원 응답을 임의의 공용 사용자로 대체하지 않는다.

## 5. 데이터 모델

관계의 중심은 사양서 4·5·8·10·11쪽을 따른다.

```text
User
|-- Session [0..N]
`-- Person [0..N]
    `-- Reading [0..N]
        |-- ReadingCard [3]
        |   `-- ReadingEvidence [1..N]
        `-- ReadingAttempt [1..3]

Question
`-- CardPosition [3]

TarotCard
`-- Interpretation [0..N]
    `-- InterpretationVersion [1..N]
```

테이블 이름과 핵심 필드는 아래를 기준으로 구체화한다. 모든 ID는 UUID, 시각은 UTC `timestamptz`를 사용한다. 아래 표의 필드는 주요 필드이며 생성 시각 등 공통 필드는 생략했다.

| Table | Core fields | Constraint / purpose |
| --- | --- | --- |
| users | id, provider, app_name, subject_digest, digest_version | unique external subject |
| sessions | token_hash, user_id, expires_at, revoked_at | unique token hash |
| persons | id, user_id, nickname, relationship_code, current_situation, version | unique (id, user_id) |
| questions | id, version, kind, text, relationship_codes, active | recommended / custom_template |
| card_positions | id, question_id, position_index, label, instruction | unique (question_id, position_index) |
| tarot_cards | id, code, name, name_ko, arcana_type, image_url, active | unique code; nullable image |
| interpretations | id, card_id, active_version, active | logical meaning identity |
| interpretation_versions | interpretation_id, version, text, metadata, source_kind | immutable content version |
| readings | id, user_id, person_id, status, request_snapshot, result_json, contract_version, prompt_version | immutable input; owner scope |
| reading_cards | id, reading_id, card_id, position_index, card_snapshot, position_snapshot | unique card and position per reading |
| reading_evidence | reading_card_id, interpretation_id, version, text_snapshot, metadata_snapshot, selected | exact supplied and selected evidence |
| reading_attempts | id, reading_id, attempt_no, status, claimed_at, lease_expires_at, error_code, provider, model, usage | unique (reading_id, attempt_no) |
| idempotency_requests | user_id, operation, key, request_hash, resource_id, attempt_id | unique (user_id, operation, key) |

원문과 이력의 정합성은 DB 제약과 애플리케이션 검증으로 함께 보장한다. 원문 버전의 기본 키는 `(interpretation_id, version)`이고, 근거는 이 버전을 외부 키로 참조한다. 같은 카드의 같은 근거 버전을 중복 저장하지 않는다. 위치 번호에는 1~3 CHECK와 질문·리딩별 유일 제약을 두고, 공개 질문과 생성 리딩에 정확히 3개가 있는지는 트랜잭션 안에서 검사한다.

`readings(person_id, user_id)`에서 `persons(id, user_id)`로 복합 외부 키를 두어 다른 소유자의 Person과 연결되지 않게 한다. 삭제·갱신 시 참조 규칙도 migration에 선언한다.

질문과 위치는 서버 데이터로 관리한다. 공개 중인 질문에는 위치 번호 1·2·3이 모두 있어야 한다. 직접 질문은 `kind=custom_template` 질문 데이터를 사용하고, 사용자가 입력한 자유문을 리딩 입력에 저장한다. 직접 질문의 카드 역할도 코드에 고정하지 않으며, 위치 변경 시 질문 version을 함께 올린다.

관계 코드는 서버 관리 선택지로 제공하고, 질문의 `relationship_codes`로 추천 대상을 제한한다. 빈 배열은 공통 질문이다. 초기 질문문·위치·분류는 샘플 콘텐츠로 관리하여 후속 검증에서 바꿀 수 있게 한다.

원문이 없는 카드도 마스터에는 등록할 수 있다. 리딩에는 유효한 해석 버전이 있는 카드만 선택할 수 있다. 다른 카드 ID 3개를 위치 번호 1·2·3에 하나씩 지정하며, `orientation`으로 의미를 추가하거나 반전하지 않는다.

Person 수정은 version으로 충돌을 감지한다. Reading 생성 시 별명·관계·상황, 질문 본문·version, 위치, 카드 정보, 후보 원문의 ID·version·본문을 복사한다. 이후 Person이나 원문을 수정해도 과거 입력과 결과는 바뀌지 않는다. 원문 버전은 덮어쓰지 않고 새 버전을 추가한다.

AI에 전달한 후보와 AI가 선택한 근거를 `reading_evidence`로 추적한다. 입력·출력의 근거를 보존하는 것이며, 모델이 같은 문장을 다시 생성한다고 보장하는 것은 아니다.

우선 색인은 `persons(user_id, created_at, id)`, `readings(user_id, person_id, created_at, id)`, 카드별 유효 원문 조회, 대기 Reading의 `status, created_at`과 attempt의 lease 만료 조회에 둔다. 리딩 건수·마지막 리딩 시각은 성공한 Reading에서 집계한다.

migration은 적용 번호를 기록하고 적용된 파일은 수정하지 않는다. 변경은 새로운 migration으로 추가한다. 개발·테스트·QR 검증용 DB를 분리하고, 서버 시작 시 기존 데이터를 삭제하지 않는다.

## 6. HTTP API 계약

공통 prefix는 `/v1`이다. 세션 발급과 health 외에는 서비스 세션이 필요하다. 요청의 알 수 없는 필드는 거절하고, 요청 전체 크기는 초기 16 KiB로 제한한다. DB·외부 API 검증은 JSON 형식 검사 이후 수행한다.

| Method | Path | Input | Successful response |
| --- | --- | --- | --- |
| POST | /v1/sessions/toss-anonymous | anonymousKey | 201: token, expiresAt |
| DELETE | /v1/sessions/current | - | 204 |
| GET | /v1/relationship-types | - | 200: code, label list |
| POST | /v1/persons | nickname, relationshipCode, currentSituation? | 201: Person |
| GET | /v1/persons | cursor?, limit? | 200: items, nextCursor |
| GET | /v1/persons/:personId | - | 200: Person, readingCount, lastReadingAt |
| PATCH | /v1/persons/:personId | version, changed fields | 200: updated Person |
| GET | /v1/questions | relationshipCode | 200: questions and 3 positions each |
| GET | /v1/cards | - | 200: selectable card metadata |
| POST | /v1/readings | Person + Question + selections | 202; 200 on replay: readingId, status, attemptNo, statusUrl |
| GET | /v1/readings/:readingId | - | 200: status, attemptNo, input summary, result or error |
| GET | /v1/persons/:personId/readings | cursor?, limit? | 200: items, nextCursor |
| POST | /v1/readings/:readingId/retry | expectedAttemptNo | 202; 200 on replay: same readingId, attemptNo, statusUrl |
| GET | /health/ready | - | 200 or 503 |

Person의 별명과 관계는 필수다. 상황은 선택이며 100~300자는 사양서의 권장 길이로 유지한다. 초기 기술적 상한 제안은 별명 30자, 상황 2,000자, 직접 질문 500자다. 길이는 Unicode code point로 계산한다. 빈 별명·빈 질문, 존재하지 않는 관계 코드는 거절한다. 이 상한은 사업 정책이나 최종 UX 문구의 확정이 아니다.

목록은 `(created_at, id)` 내림차순 커서 방식으로 조회한다. 기본 20개, 최대 100개다. 기록 목록에는 상태·질문·요약·생성 시각을 내려주고, 전체 결과는 상세 API로 조회한다. 원문 후보 전체와 운영용 실행 정보는 사용자 응답에 포함하지 않는다.

`POST /v1/readings`의 body는 다음 의미를 가진다.

| Field | Contract |
| --- | --- |
| personId | owned Person UUID |
| personVersion | expected current Person version |
| question.id | recommended question or custom template UUID |
| question.version | expected content version |
| question.customText | required only for custom_template |
| selections | exactly 3 items |
| selections[].positionIndex | integer 1..3; all distinct |
| selections[].cardId | active card UUID; all distinct |

추천 질문에서는 `customText`를 금지하고 DB의 질문문을 사용한다. 직접 질문에는 활성 custom template와 자유문이 모두 필요하다. 클라이언트가 카드 위치 설명·원문 해석·AI 결과를 전송해 서버 값을 덮어쓸 수 없다.

초기 테스트 폼은 카드 메타데이터에서 3장을 직접 고른다. 최종 뒷면 카드 풀·무작위 배치·한 장씩 공개하는 경험은 디자인 단계에서 연결한다. 서버는 선택된 카드와 위치의 유효성에 책임을 두며, 현재 계약을 카드 배치 알고리즘의 확정으로 해석하지 않는다.

오류 body는 `{error: {code, message, retryable, requestId}}`로 통일한다. 공급자 오류 원문이나 비밀값은 반환하지 않는다.

| HTTP | Example code | Meaning |
| --- | --- | --- |
| 400 | INVALID_REQUEST | malformed or out-of-range input |
| 401 | AUTH_REQUIRED | invalid or expired session |
| 404 | NOT_FOUND | missing or inaccessible resource |
| 409 | STALE_VERSION | changed Person or question |
| 409 | IDEMPOTENCY_CONFLICT | same key; different request |
| 409 | RETRY_NOT_ALLOWED | active, completed or exhausted attempt |
| 422 | CONTENT_UNAVAILABLE | missing valid interpretation |
| 422 | INPUT_NOT_SUPPORTED | input cannot be processed as a reading |
| 429 | RATE_LIMITED | request or active-reading limit |
| 503 | DEPENDENCY_UNAVAILABLE | DB, auth verification or provider setup failure |

생성 이후 발생한 AI 오류는 조회 API의 HTTP 오류가 아니라 Reading의 `FAILED` 상태와 오류 코드로 반환한다. AI 실패를 성공한 타로 결과로 포장하지 않는다.

## 7. 원문에 근거한 AI 처리

처리 순서는 사양서 7·9·18쪽을 기준으로 한다.

1. 소유권·입력·질문 version·카드 3개를 검증한다.
2. 일관된 DB 스냅샷에서 관계·상황·질문·위치와 카드별 활성 원문을 읽는다.
3. 초기 샘플에서는 카드별 활성 원문을 모두 후보로 전달한다. 임의의 의미 생성이나 미확정 태그로 후보를 제거하지 않는다.
4. 입력 스냅샷과 후보 근거를 Reading에 먼저 저장하고 attempt를 대기 상태로 만든다.
5. worker가 저장된 입력을 AI 어댑터에 전달한다.
6. 출력 JSON의 구조와 근거 참조를 검증한 뒤 결과·선택된 근거·성공 상태를 함께 저장한다.

프롬프트는 버전이 있는 서버 템플릿이다. worker는 Reading에 저장된 `prompt_version`의 템플릿을 읽으며 재시도 중 최신 템플릿으로 교체하지 않는다. 해당 버전을 제공할 수 없으면 설정 오류로 중단한다. 사용자 자유문과 원문은 데이터 필드에 담으며 시스템 지시로 취급하지 않는다. 관계·상황·질문·위치·원문을 전달하고, 내부 userId·식별키·세션·Person 별명은 전송하지 않는다. 자유문 안에 사용자가 직접 적은 이름 등이 있을 수 있으므로 이를 자동으로 익명 데이터라고 간주하지 않는다.

AI 어댑터의 입력은 `ReadingContext`, 출력은 `ReadingResult`로 고정한다. 실제 공급자와 모델은 환경 설정으로 선택하고 사용한 값을 attempt에 기록한다. 공급자의 JSON Schema 출력 기능을 사용할 수 있으면 활용하되, 서버 검증은 항상 수행한다. 최종 모델 선정은 비용·속도·원문 충실도 평가 후 결정한다.

결과 계약 `reading-result.v1`은 다음과 같다. 사양서의 카드별 결과 3개를 배열로 표현하며 종합 리딩과 요약을 별도 필드로 둔다.

| Field | Type / constraint |
| --- | --- |
| cards | array; exactly 3 |
| cards[].positionIndex | integer 1..3; all distinct |
| cards[].cardId | must match selected card at this position |
| cards[].text | non-empty string; max 800 code points |
| cards[].evidence | non-empty array; no duplicate pairs |
| cards[].evidence[].interpretationId | supplied evidence ID for this card |
| cards[].evidence[].version | supplied version for this ID |
| overallReading | non-empty string; max 2000 code points |
| summary | non-empty string; max 120 code points |

상한은 비용·응답 안정성을 위한 초기 기술값이다. 계약에 없는 필드는 거절한다. 다른 카드의 근거, 존재하지 않는 ID, 후보에 없는 버전, 누락·중복 위치를 검출하면 `AI_OUTPUT_INVALID`로 처리하고 결과를 노출하지 않는다. `aiGenerated: true`는 AI가 아닌 서버가 응답 메타데이터에 설정한다.

ID와 JSON 검증만으로 의미의 충실도를 보장할 수는 없다. 올바른 ID를 인용하면서 원문을 뒤집을 수도 있으므로, 타로리더가 확인한 샘플셋으로 카드별 의미 보존·질문 맥락·종합 흐름·단정적 예언 여부를 별도로 평가한다. 일반 지식으로 원문을 보충하거나 누락된 해석을 AI가 작성하는 fallback은 두지 않는다.

입력·출력의 처리 가능 여부를 확인하는 경계를 AI 어댑터 앞뒤에 둔다. 제공자 거절과 정책상 처리할 수 없는 입력은 리딩 결과와 구분한다. 실제 공개 서비스의 운영 필터·안전 응답·AI 변경 검토 요건은 플랫폼 적용 범위를 확인해 출시 검증에 반영한다. [앱인토스 AI 서비스 안내](https://developers-apps-in-toss.toss.im/intro/caution)

초기 컨텍스트는 카드당 최대 20개 원문과 공급자별 입력 토큰 예산으로 제한한다. 예산 초과 시 원문을 조용히 잘라내지 않고 `CONTENT_CONTEXT_LIMIT`로 중단한다. 실제 콘텐츠가 늘어 이 제한에 도달하면, 사양서의 후속 단계에서 후보 선별 방식을 검토한다.

## 8. 생성 상태, 중복 방지, 장애 복구

리딩 생성 요청은 DB에 먼저 기록한 뒤 202와 조회 주소를 반환한다. 브라우저 연결을 유지하면서 AI 완료를 기다리거나, 응답 후 메모리에만 남긴 작업에 의존하지 않는다. 화면은 초기 2초 간격으로 상태를 조회하고, 앱 재접속 시에도 같은 Reading을 조회한다.

```text
QUEUED -> RUNNING -> SUCCEEDED
   |          |
   +----------+--> FAILED
                     |
                     +-- explicit retry --> QUEUED
                         (same Reading; next attempt)
```

상태와 실행 기록은 다음 규칙으로 관리한다.

- Reading의 입력·후보 원문·프롬프트 계약은 최초 생성 시 고정한다. 재시도는 같은 입력을 사용한다. 질문·상황·카드를 바꾸려면 새 Reading을 생성한다.
- worker는 짧은 트랜잭션에서 대기 Reading을 `FOR UPDATE SKIP LOCKED`로 확보한 뒤 해당 attempt를 잠그고 RUNNING과 lease를 기록한다. claim·완료·만료·retry 모두 Reading, attempt 순서로 잠근다. 외부 AI 호출 중 DB 잠금을 유지하지 않는다. 이 잠금 방식은 작업 대기열에만 적용한다. [PostgreSQL 공식 문서](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- 초기 제안값은 AI 요청 제한 20초, worker lease 45초, 대기열 제한 60초, worker 동시 실행 2개다. 운영 측정 후 설정으로 조정한다.
- 각 attempt는 AI 호출을 최대 한 번만 시작한다. 공급자 SDK의 숨은 자동 재시도는 끈다. 실패하면 사용자가 명시적으로 재시도하며, 최초 실행을 포함해 Reading당 최대 3개 attempt를 허용한다. 이는 무료 이용 횟수나 가격 정책이 아니다.
- 일시적 네트워크 오류·타임아웃·형식 오류는 남은 attempt가 있으면 재시도 가능하다. API 설정 오류, 원문 부족, 정책상 거절은 원인을 해결하기 전 재시도를 허용하지 않는다.
- worker 중단으로 lease가 만료되면 해당 attempt를 FAILED로 마감한다. 응답을 받지 못한 AI 호출을 자동 반복하지 않는다. 대기만 하다가 제한을 넘긴 경우도 `QUEUE_TIMEOUT`으로 종료한다.
- 성공 저장은 해당 attempt가 여전히 RUNNING이고 lease가 유효하며 Reading의 현재 실행인 경우에만 허용한다. 늦게 돌아온 이전 실행이 새 실행이나 실패 상태를 덮어쓰지 못한다. 결과·선택 근거·attempt 성공·Reading 성공을 한 트랜잭션으로 기록한다.
- DB가 결과를 저장하지 못하면 성공으로 표시하지 않는다. 재기동 후 lease 만료 처리로 복구한다. 외부 AI가 이미 처리했는지 모르는 타임아웃에서는 공급자 과금까지 정확히 한 번임을 보장할 수 없다.

`POST /readings`와 retry에는 클라이언트가 생성한 `Idempotency-Key` UUID를 요구한다. 네트워크 재전송에는 같은 키를 유지하고, 새로운 작업에만 새 키를 사용한다. 서버는 사용자·작업 경로·키의 유일 제약으로 동시 요청도 묶는다.

인증과 형식 검사 후 기존 키를 먼저 확인한다. 같은 키·같은 정규화 요청이면 새 Reading이나 attempt 없이 기존 자원을 반환한다. 첫 접수는 202, 재전송 조회는 200이다. 같은 키에 다른 입력이면 409다. 과거 요청의 재전송에 현재 Person·콘텐츠를 다시 적용하지 않는다.

새 요청은 소유권·version·콘텐츠 검증, 스냅샷 생성, Reading·카드 3개·근거·attempt·멱등 키 저장을 하나의 트랜잭션으로 처리한다. Person 및 질문 갱신과 충돌하면 `STALE_VERSION`으로 종료한다. 내용 복사 도중 버전이 섞이지 않도록 일관된 읽기 스냅샷과 해당 데이터의 잠금을 사용한다.

retry는 Reading을 잠근 뒤 `expectedAttemptNo`, FAILED 여부, 재시도 가능 원인, 남은 횟수를 함께 검사한다. 같은 Reading에 QUEUED/RUNNING attempt가 하나만 존재하도록 부분 유일 색인을 둔다. 같은 사용자의 활성 Reading도 초기에는 하나로 제한해 중복 클릭과 과도한 비용을 줄인다. 제한은 DB에서 검사하여 API 프로세스가 여러 개여도 일관되게 적용한다.

멱등 키 기록은 연결된 Reading의 보존 기간 동안 유지한다. 사용자 데이터 삭제 시 함께 제거하며, 외부에 공개하지 않는다. 사용자별 활성 Reading 제한은 한 사용자에 대한 짧은 DB 잠금과 QUEUED/RUNNING 상태의 부분 유일 색인으로 적용한다. 정상 재전송은 이 제한을 새 요청처럼 다시 소비하지 않는다.

## 9. 토스 연결과 운영 준비

첫 구현 작업에서 `ai-tarot/apps-in-toss.config.ts`의 `appName`을 `tarororo`로 맞추고 README의 빌드 산출물 설명을 갱신한다. 폴더명과 npm 패키지명은 식별자와 별개이므로 변경할 필요가 없다. 이후 생성되는 번들을 콘솔의 같은 앱으로 연결하고 QR 테스트로 최소 화면과 서버 통신을 확인한다.

현재 시점의 신규 SDK 3.x 업로드는 아래 Origin을 기준으로 CORS를 설정한다. 문서에는 2026-08-25 이전 Origin도 함께 나와 있으므로 실제 QR WebView의 Origin으로 재확인한다. [서버 API·CORS 공식 안내](https://developers-apps-in-toss.toss.im/documentation/integration/server-api)

| Environment | Allowed origin |
| --- | --- |
| Production | https://tarororo.apps.tossmini.com |
| Console QR | https://tarororo.private-apps.tossmini.com |
| Local only | http://localhost:5173 / http://127.0.0.1:5173 |

운영 서버에는 localhost 허용을 넣지 않는다. 서비스 API는 HTTPS로 제공하고, Toss로의 요청은 서버의 전용 TLS 클라이언트에 인증서·개인 키를 연결한다. mTLS 인증서를 AI 공급자 요청에 재사용하지 않는다. 인증서 검증을 끄거나 키를 프런트엔드 번들로 전달하지 않는다.

필요 설정의 위치는 다음과 같다. 이 문서에는 실제 비밀값을 기록하지 않는다.

| Setting | Location / purpose |
| --- | --- |
| VITE_API_BASE_URL | public frontend build setting |
| DATABASE_URL | server secret |
| AUTH_SUBJECT_SECRET | stable server secret; versioned rotation |
| TOSS_MTLS_CERT_PATH / TOSS_MTLS_KEY_PATH | server secret files |
| AI_PROVIDER / AI_MODEL | server runtime configuration |
| AI_API_KEY | server secret |
| ALLOWED_ORIGINS | environment-specific API configuration |
| AUTH_MODE | mock only in isolated local development |

DB와 백업은 암호화·접근 제한을 지원하는 환경을 사용한다. 요청 body·익명 키·세션·사용자 질문·원문 전체·AI 응답 원문을 일반 로그에 남기지 않는다. 로그에는 내부 requestId, 상태, 오류 코드, 지연 시간, 공급자·모델·사용량처럼 진단에 필요한 항목을 남긴다. HMAC 키와 mTLS 파일은 백업·교체 책임을 정하고 만료 전에 교체한다.

실제 공개 전에는 사용자 입력의 저장 범위·보존 기간·삭제 절차와 AI 제공 사실 안내를 기획·운영 측과 확정한다. 인연·리딩·근거 스냅샷에도 사용자 입력이 복사되므로 삭제 대상에 모두 포함해야 한다. 현재 샘플 개발 데이터를 실제 사용자 데이터와 혼합하지 않는다.

공개 환경의 AI 공급자·모델·프롬프트는 버전으로 관리한다. 비용·품질 실험은 개발 환경에서 하고, 공개 환경에 적용할 때 플랫폼의 AI 서비스 변경 검토 요건을 확인한다. `PREPARE` 상태나 콘솔 등록만으로 출시 요건을 충족했다고 판단하지 않는다.

## 10. 검증 항목과 요구사항 추적

새 서버는 Node 기본 test runner를 사용해 계약·도메인 검사를 수행한다. DB 제약·트랜잭션·동시 요청 검사는 격리된 실제 PostgreSQL에서 한다. AI 모의 응답 검증과 실제 모델 평가 결과는 구분해 기록한다.

| ID | Source | Acceptance evidence |
| --- | --- | --- |
| R01 | spec p.4,10 | one User; multiple Persons; isolated histories |
| R02 | spec p.4,11 | Person update does not rewrite old Reading input |
| R03 | spec p.5 | recommended and custom question use 3 data-defined positions |
| R04 | spec p.6 | reject duplicate cards, invalid IDs and missing positions |
| R05 | req.txt; spec p.7,8 | multiple reader interpretations per card |
| R06 | spec p.9 | all 3 card results, overallReading and summary validated |
| R07 | spec p.11,18 | exact supplied and selected interpretation versions retained |
| R08 | spec p.13,18 | timeout, malformed output and provider refusal handled |
| R09 | spec p.18 | simultaneous duplicate request creates one Reading and attempt |
| R10 | spec p.18 | expired worker cannot overwrite retry result |
| R11 | spec p.12,20 | real Toss identity; HTTPS; reopen and retrieve same history |
| R12 | spec p.7,18 | reader review detects invented or reversed meanings |

성공 경로에 더해 다음 실패·변경 시나리오를 확인한다.

- 다른 사용자의 Person·Reading·retry 접근을 거절한다. 사용자 ID를 바꾸거나 미검증 익명 키를 보내 기록을 가져올 수 없어야 한다.
- `success: false`, `"false"`, HTTP 200의 `FAIL`을 인증 성공으로 취급하지 않는다.
- 한 카드라도 원문이 없으면 AI를 호출하지 않는다. 다른 카드의 근거 ID, 알 수 없는 version, 누락 필드가 있는 출력은 성공으로 저장하지 않는다.
- Person·질문·원문 수정 후에도 과거 결과와 근거를 조회할 수 있다. retry에도 최초 입력을 사용한다.
- 같은 멱등 키의 동시 요청, 다른 body의 재전송, 동시 retry, worker 중단·재시작을 검증한다.
- 앱을 닫아도 결과 또는 명확한 실패 상태로 끝나고, 재접속해서 상태를 확인할 수 있다.
- 프런트엔드 빌드 결과에 비밀값이나 개발용 인증 코드가 포함되지 않아야 한다.

품질 평가에는 타로리더가 확인한 카드 3~5장과 카드당 3~5개 해석을 사용한다. 제공 전에는 `source_kind=synthetic_test`로 표시한 시험 문장으로 저장·API 동작만 검증할 수 있다. 합성 문장을 타로리더 원문으로 취급하거나 원문 충실도 합격 증거로 사용하지 않는다. 운영 환경에서는 시험 콘텐츠를 제공하지 않는다.

## 11. 구현 순서와 필요한 준비

```text
1. Align appName + define contracts + establish local PostgreSQL
2. Identity adapter + Person / Question / Card / Interpretation data
3. Reading snapshot + idempotency + durable attempt lifecycle
4. AI adapter + output validation + save / reload
5. Temporary form + real provider evaluation
6. Toss QR test + reopen / ownership / failure verification
```

로컬 데이터·계약·장애 처리는 개발용 어댑터로 시작할 수 있다. 실제 AI 시험에는 사용 가능한 API 키와 테스트 모델, 의미 평가에는 리더 원문, 실기기 시험에는 HTTPS 서버·DB·tarororo용 mTLS 인증서가 필요하다. 해당 자격 증명과 운영 자원의 준비 여부는 이번 문서 작성에서 확인하거나 변경하지 않았다.

별도 운영 환경 정보가 제공되기 전 초안의 기준은 Node.js + PostgreSQL이다. 특정 업체의 계약·과금이나 운영 자원 생성은 이 문서의 결과물에 포함하지 않는다. 최종 AI 모델, 가격, 역방향, UI, 전체 78장 콘텐츠는 샘플 평가와 후속 기획·디자인에서 결정한다.

이번 결과물은 기술 설계 초안이다. 백엔드·DB·AI 연동의 구현 완료나 실행 검사 통과를 의미하지 않는다.
