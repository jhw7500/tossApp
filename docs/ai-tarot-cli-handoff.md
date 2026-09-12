# 프로젝트 인계: 앱인토스 AI 타로 서비스

> 최신 상태: 2026-09-12 KST. 아래 `0. 백엔드 구현 인계`가 현재 작업 상태다.
> 뒤의 1~7절은 프로젝트 시작 당시의 역사적 브리프이며, 현재 구현 범위나 중단 조건보다 우선하지 않는다.

## 0. 백엔드 구현 인계

### 인계 판정

`HANDOFF_READY`. 진행 중인 구현이나 테스트는 없고, 이 세션이 시작한 서버·컨테이너도 모두 종료했다. 현재 변경은 검증 완료된 미커밋 상태다. 새 기능을 시작하기 전에 OMX 관리 세션에서 변경 보존 방식, 커밋 구성, 최신 `origin/main` 통합 순서를 결정해야 한다.

### Git 상태

| 항목 | 현재 값 |
| --- | --- |
| 저장소 | `jhw7500/tossApp` |
| worktree | `/home/jhw/ai/opencode/projects/tossApp/.worktrees/session-backend-ai` |
| 브랜치 | `feat/backend-ai-next` |
| HEAD | `28bde738826d1758eb3422281ea396af777a9423` (`feat: paginate person and reading lists (#2)`) |
| upstream | 없음 |
| 원격 브랜치 | `origin/feat/backend-ai-next` 없음 |
| 현재 브랜치 PR | 없음 |
| 기준 브랜치 | `origin/main` = `18348b3` |
| 기준과의 차이 | 로컬 고유 커밋 0개, `origin/main` 쪽 6개; merge-base는 현재 HEAD |
| worktree 상태 | dirty, 모든 신규 구현이 미커밋 |

현재 세션에서 커밋·푸시·PR 생성은 하지 않았다. 현재 HEAD까지 포함된 기존 PR은 다음과 같다.

- PR #1 `feat: implement AI tarot reading foundation`: MERGED, `2026-09-11T14:10:38Z`
- PR #2 `feat: paginate person and reading lists`: MERGED, `2026-09-11T14:48:11Z`

### 완료한 백엔드 작업

1. 근거 기반 AI 리딩 품질 평가
   - 전체 후보 출처와 선택 근거를 보존하는 사람 검토 패킷을 구현했다.
   - 의미 보존, 근거 선택, 질문 맥락, 전체 흐름, 비단정적 언어의 다섯 기준을 검증한다.
   - 합성 출처가 하나라도 있으면 결과를 항상 `MECHANICS_ONLY`로 제한한다.
   - 실제 타로 리더 원문은 제공되지 않아 reader-content `PASS`는 주장하지 않는다.

2. Worker 수명주기 관측
   - `reading_attempt_started`와 `reading_attempt_finished` JSON Lines 이벤트를 추가했다.
   - 내부 Reading/attempt ID, provider/model, 상태, 소요 시간, 안전한 token usage 또는 정규화한 오류 코드만 기록한다.
   - 늦은 완료·실패는 `STALE`로 기록하며 동기·비동기 observer 실패가 작업 결과에 영향을 주지 않는다.

3. API 관측
   - 완료된 응답마다 `api_request_finished` 이벤트 하나를 기록한다.
   - request ID, 상태 코드, 소요 시간, 정규화한 오류 코드만 허용한다.
   - URL, IP, header, body, 세션/사용자/질문/출처/결과 정보가 Fastify 내부 로그로 새지 않도록 Fastify logger를 비활성화했다.
   - graceful shutdown 중 이미 수락된 요청도 정상 수명주기 이벤트를 남긴다.

4. 익명 사용자 HMAC 비밀키 교체
   - `004_subject_identity_rotation.sql`에 identity alias 테이블, 기존 사용자 백필, 구 코드 사용자 삽입 포착 trigger를 추가했다.
   - 활성 키와 이전 키 후보를 모두 조회·등록하고, 정렬된 PostgreSQL advisory lock으로 혼합 버전 동시 요청을 같은 사용자로 수렴시킨다.
   - 키 교체 뒤에도 기존 세션, Person, Reading 소유권이 같은 내부 사용자 ID에 남는다.
   - 이미 서로 다른 사용자로 갈라진 identity가 감지되면 임의 병합하지 않고 세션 생성을 롤백한다.
   - `AUTH_SUBJECT_SECRET_VERSION`과 `AUTH_SUBJECT_PREVIOUS_SECRETS`를 검증하고 안전한 배포·보존 절차를 `server/README.md`와 `.env.example`에 기록했다.

진행 중인 코드 작업은 없다. 위 네 작업은 각각 독립 리뷰를 거쳤고, 마지막 HMAC 재검토 결과는 Critical/Important/Minor 없음, `APPROVE`였다. API/Worker/품질 평가에서 발견된 이전 리뷰 지적도 수정 후 검증했다.

### 최종 검증 결과

| 검증 | 결과 |
| --- | --- |
| `npm test` | 45/45 통과 |
| PostgreSQL `npm run test:integration` | 53/53 통과 |
| `npm run typecheck` | 통과 |
| `npm run quality:evaluate -- fixtures/quality/synthetic-mechanics.json` | `MECHANICS_ONLY`, failed criteria 없음 |
| `git diff --check` | 통과 |
| HMAC 혼합 버전 스트레스 검토 | 50 keys -> 50 users / 100 aliases, 사용자 분리 없음 |

통합 테스트는 격리 schema와 임시 `postgres:16-alpine` 컨테이너를 사용했으며 외부 AI API를 호출하지 않았다.

### 미커밋 변경

Tracked 수정 17개(인계 문서 포함):

```text
M  docs/ai-tarot-cli-handoff.md
M  server/.env.example
M  server/README.md
M  server/package.json
M  server/src/app.ts
M  server/src/auth/sessions.ts
M  server/src/config.ts
M  server/src/db/migrate.ts
M  server/src/errors.ts
M  server/src/main.ts
M  server/src/readings/attempts.ts
M  server/src/worker/main.ts
M  server/src/worker/run.ts
M  server/tests/config.test.ts
M  server/tests/database.test.ts
M  server/tests/helpers.ts
M  server/tests/reading-worker.test.ts
```

Untracked 신규 파일 11개:

```text
server/fixtures/quality/synthetic-mechanics.json
server/migrations/004_subject_identity_rotation.sql
server/src/ai/evaluate-quality.ts
server/src/ai/quality-evaluation.ts
server/src/http/api-observability.ts
server/src/worker/log.ts
server/tests/api-log.test.ts
server/tests/api-observability.test.ts
server/tests/quality-evaluation.test.ts
server/tests/subject-identity.test.ts
server/tests/worker-log.test.ts
```

이 인계 문서 수정도 아직 커밋되지 않았다. `server/README.md`, `server/package.json`은 여러 완료 작업이 함께 수정한 공유 파일이므로 변경을 나눠 커밋할 때 hunk 단위 검토가 필요하다.

### 남은 문제와 다음 작업

- 알려진 Critical/Important 코드 결함은 없다.
- 현재 브랜치는 `origin/main`보다 6커밋 뒤이고 worktree가 dirty다. 미커밋 변경을 보존하지 않은 채 reset, checkout, rebase, worktree 삭제를 실행하면 안 된다.
- OMX 관리 세션의 첫 작업은 전체 diff와 이 문서를 확인한 뒤 커밋을 한 개로 묶을지 작업별로 나눌지 결정하는 것이다. 변경을 안전하게 보존한 후 `origin/main` 위로 통합하고 충돌을 해결한다.
- 기준 브랜치 통합 뒤 단위 테스트, 전체 PostgreSQL 통합 테스트, typecheck, quality fixture, `git diff --check`를 다시 실행한다.
- 실제 검수된 타로 리더 출처가 없으므로 reader-content 품질 평가는 여전히 남아 있다. 원문과 검토자를 확보하기 전에는 합성 fixture 결과를 콘텐츠 품질 통과로 바꾸지 않는다.
- 실제 Toss mTLS 자격 증명, QR 실기기 식별키 동작, 운영 배포는 이 worktree에서 검증하지 않았다.
- 다음 제품 기능은 선택하지 않았다. 브랜치 정리와 통합 판단 전에는 새 기능을 시작하지 않는다.

### 실행 중 자원

| 자원 | 상태 | 인계 조치 |
| --- | --- | --- |
| `session-backend-ai`의 Node/API/worker 프로세스 | 없음 | 조치 없음 |
| 이 세션의 임시 PostgreSQL 컨테이너 | 모두 제거 및 부재 확인 | 재사용하지 않음 |
| tmux `tarororo-live:dev` | 실행 중, cwd는 `.worktrees/backend-foundation` | 다른 worktree의 공유 개발 환경이므로 유지 |
| `tarororo-test-api-1` | 실행 중, healthy, `.worktrees/backend-foundation/deploy/pc-test` 소유 | 유지, 이 인계 작업에서 종료하지 않음 |
| `tarororo-test-worker-1` | 실행 중, 같은 PC test stack 소유 | 유지, 이 인계 작업에서 종료하지 않음 |
| `tarororo-test-db-1` | 실행 중, healthy, 같은 PC test stack 소유 | 유지, 이 인계 작업에서 종료하지 않음 |
| `tossapp-foundation-3a44f8b2` | 실행 중인 `postgres:18-alpine`, 소유 세션 미확인 | 유지, 소유 확인 전 종료 금지 |
| `frosty_lewin` | 실행 중인 `johyunwoo/imx93`, 이 백엔드 작업과 무관 | 유지, Yocto 관련 작업·중단 금지 |

이 백엔드 세션이 점유한 포트나 후속 정리가 필요한 테스트 schema는 없다.

너는 이 프로젝트의 개발 파트너다. 아래 내용을 기준으로 현재 환경을 확인하고, 도구 구성과 첫 버전의 개발 계획을 제안해라. 아직 승인되지 않은 설계나 도구를 확정된 것으로 취급하지 마라.

## 1. 확정된 목표와 미정 사항

- 목표: 토스 앱 안에서 이용하는 앱인토스(Apps in Toss)용 AI 타로 서비스를 만든다.
- 개발 도구: Codex 또는 Claude Code를 사용한다. 필요하면 한쪽은 구현, 다른 쪽은 검토를 맡긴다.
- 플러그인·MCP·스킬을 활용하되, 처음부터 많은 도구나 복잡한 다중 에이전트 환경을 구성하지 않는다.
- 프런트엔드·백엔드·DB·서비스용 AI 모델·수익모델은 아직 최종 결정하지 않았다.
- 이 문서의 MVP 범위와 기술 선택은 초기 제안이며, 사용자의 확정 요구사항과 구분해라.

## 2. 먼저 검토할 개발 도구

아래 이름은 이전 논의에서 제시된 후보다. 현재 CLI에 설치되어 있다고 가정하지 말고, 공식 여부·현재 지원 범위·호환성·설치 명령을 원문에서 검증해라. 확인되지 않은 이름이나 명령을 만들어내지 마라.

### 우선 검토

1. 앱인토스 공식 개발 도구
   - 확인 후보: `toss/apps-in-toss-harness`, `ait@apps-in-toss`.
   - MCP 확인 후보: `apps-in-toss-docs`, `apps-in-toss-console`.
   - 역할: 공식 SDK·문서 조회, 프로젝트 구성, 토스 UI 기준 확인, 콘솔 연동, 테스트 및 업로드 지원.
   - Codex와 Claude Code에서 실제 지원하는 기능, 특히 실기기 디버깅 지원 차이를 확인해라.
   - 플러그인에 MCP가 포함되어 있다면 동일 MCP를 중복 등록하지 마라.

2. Superpowers
   - 확인 후보 저장소: `obra/superpowers`.
   - 역할: 요구사항 정리, 구현 계획, TDD, 체계적 디버깅, 코드 검토, 완료 전 검증.
   - 우선 검토할 스킬: `brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`.
   - 앱인토스 도구는 플랫폼 규칙을, Superpowers는 개발 절차와 검증을 담당하게 하고 기획 문서를 중복 생성하지 마라.

3. Playwright
   - 역할: 화면 흐름과 오류 상황의 브라우저 검증.
   - CLI + 스킬 방식과 MCP 방식을 비교해 현재 환경에 맞는 하나부터 선택해라.
   - 브라우저 자동화 도구만 연결한 것을 테스트 완료로 취급하지 말고, 재실행 가능한 테스트도 계획해라.
   - 브라우저 검증과 토스 앱 실기기 검증을 구분해라.

### 필요할 때 추가

- Supabase MCP: Supabase를 DB로 선택했을 때만 검토한다. 개발용 프로젝트의 스키마·마이그레이션·쿼리·로그 확인용이며, 서비스 실행에 필수인 MCP가 아니다.
- Context7: 일반 라이브러리의 버전별 문서 확인이 필요할 때 추가한다. 토스 SDK는 앱인토스 공식 문서를 우선한다.
- Figma·GitHub 등 추가 연동: 현재 작업에 구체적인 필요가 생길 때만 제안한다.

## 3. 초기 MVP 제안

제안하는 첫 사용자 흐름:

질문 입력 → 카드 3장 선택 → AI 해석 결과 표시

- 먼저 모의 해석 데이터로 화면 흐름을 검증하고, 이후 실제 AI API를 연결하는 방안을 검토한다.
- 로그인·결제·이력 저장은 후속 단계 후보로 두되, 플랫폼 요구사항 때문에 먼저 필요한 항목은 근거와 함께 설명해라.
- 카드 선택·추첨 로직과 AI 해석 생성 로직을 분리하는 방향으로 설계한다.
- 선택된 카드와 리딩 식별자를 확정한 후 해석을 생성하고, 재시도 때문에 카드가 바뀌거나 같은 요청이 중복 처리되지 않게 한다.
- AI에는 확정된 카드 정보를 전달하며, 실제로 선택하지 않은 카드를 해석하는 오류를 검증한다.
- 카드 덱, 정·역방향 사용 여부, 이미지 사용권, 보관 정책은 미정이다. 임의로 확정하지 마라.

기술 구성의 초기 후보:

- 프런트엔드: React + TypeScript + Vite 기반 클라이언트 렌더링.
- UI: TDS 및 앱인토스 공식 디자인 기준을 우선한다.
- 백엔드: AI API 호출, 인증 연계, 추후 결제 검증과 데이터 접근 제어를 담당하는 별도 서버 계층.
- DB: 필요성이 확인되면 선택한다. Supabase는 후보 중 하나다.
- 이 구성을 바로 생성하지 말고 앱인토스 제약과 현재 작업 환경에 맞는지 먼저 검증해라.

## 4. 구현 전 공식 문서에서 확인할 사항

다음 항목은 이전 대화의 설명을 그대로 확정 정책으로 쓰지 말고, 최신 공식 문서의 근거와 확인 날짜를 함께 제시해라.

- AI 타로 서비스의 등록 가능 범위와 관련 콘텐츠·심사 조건.
- WebView/React Native 등 지원 방식, CSR·SSG·SSR의 지원 및 제약.
- TDS, 라이트·다크 모드, 내비게이션 등 UI 기준.
- 로그인 기능을 제공할 때의 토스 로그인 요건.
- 유료 리딩 등 디지털 콘텐츠 판매 시 적용할 인앱 결제 방식.
- AI 기능 사용 전 안내와 AI 생성 결과 표시 요건.
- 앱인토스 서버 API별 mTLS 필요 여부와 선택할 백엔드 환경의 지원 여부.
- 테스트 번들 업로드, 실기기 검증, 심사 및 출시 절차의 차이.

## 5. 프로젝트 전용 스킬 제안

다음은 설치 가능한 기존 플러그인 이름이 아니라, 필요하면 직접 작성할 커스텀 스킬 이름이다. 첫 단계에서는 내용만 제안하고 실제 파일 생성은 승인을 받아라.

- `tarot-domain`: 카드 데이터, 배열별 의미, 선택 규칙, 결과 구조를 관리한다.
- `tarot-reading-eval`: 카드 일치, 질문 적합성, 한국어 품질, 응답 형식·길이·시간·비용을 평가한다. 시작점으로 고정 질문 30~50개 정도의 평가 세트를 검토한다.
- `ait-release-check`: 최신 공식 기준을 조회하고 로그인·결제·AI 표시·실기기 동작·실패 복구를 점검한다.

공통 규칙은 하나의 기준 문서로 관리하고, 각 CLI의 프로젝트 지침에서 참조하는 방식을 검토해라. `AGENTS.md`와 `CLAUDE.md`가 있으면 먼저 읽고 기존 지침을 덮어쓰지 마라.

스킬에 규칙을 적는 것만으로 강제된다고 보지 마라. 권한, 카드 일치, 응답 스키마, 중복 처리 방지 등 중요한 조건은 코드와 테스트에서도 검증해야 한다.

## 6. 운영·안전·테스트 원칙

- 개발용 Codex/Claude와 실제 서비스에서 호출할 AI 모델 API를 구분한다. 구독·인증·과금도 별도로 확인한다.
- 서비스용 AI API 키와 서버 인증서는 프런트엔드에 넣지 않는다.
- 타로 결과를 사실 예측이나 의학·법률·투자 판단의 근거처럼 단정하지 않는다. 불안이나 공포로 결제를 유도하지 않는다.
- 실제 상담 내용과 개인정보를 로그, MCP, 개발 에이전트에 불필요하게 노출하지 않는다.
- MCP는 필요한 권한만 부여하고, 가능하면 개발 환경과 읽기 전용 범위부터 사용한다.
- 카드 연속 클릭, 중복 선택, 긴 한국어 결과, 작은 화면, 키보드 표시, AI 응답 지연, 네트워크 단절, 새로고침과 재시도를 테스트한다.
- 결제를 추가하면 검증된 결제 결과와 이용권 지급·차감의 일관성, 중복 요청, 취소·실패·복구를 별도로 테스트한다.
- 완료 보고에는 실제 실행한 명령과 결과, 미검증 항목을 포함한다.

## 7. 이번 세션의 첫 작업과 승인 범위

이번 첫 단계에서는 조사와 계획까지만 수행해라.

1. 현재 작업 디렉터리와 기존 파일, Git 상태, 프로젝트 지침, CLI·런타임 버전, 등록된 플러그인·MCP·스킬을 읽기 전용으로 확인한다. 비밀값이나 인증 토큰을 출력하지 마라.
2. 공식 문서와 저장소를 확인해 도구 후보의 존재·설치 방식·현재 지원 범위를 검증한다. 기존 인증된 문서 조회 도구는 읽기 전용으로 사용해도 된다.
3. 최소 도구 구성, 설치 필요 항목과 예상 명령, 권한·비용·제약을 정리한다. 명령은 제시만 하고 아직 실행하지 마라.
4. MVP 화면 흐름, 구성 요소, 데이터 구조, 단계별 구현·테스트 계획을 제안한다. 확정 사항·추천 사항·미정 사항을 구분한다.
5. 사용자 결정이 반드시 필요한 사항과 다음 실행 단계를 제시하고 승인을 기다린다.

사용자 승인 전에는 프로젝트 생성, 파일 수정, 패키지·플러그인 설치, OAuth 인증 시작, 외부 리소스 생성, DB 변경, 커밋·푸시, 업로드·배포, 결제·프로모션·푸시 발송 등 상태 변경 작업을 하지 마라.

확인 가능한 정보는 먼저 조사하고, 불확실한 정책·명령·기능은 확인되지 않았다고 명시해라. 전체 구현을 한 번에 진행하지 말고, 승인된 단계씩 구현·검증·보고해라.
