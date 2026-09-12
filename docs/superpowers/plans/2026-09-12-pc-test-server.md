# PC Test Server Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this approved plan in the current session. Track each deliverable below.

**Goal:** 기존 PC에 독립적인 HTTPS 테스트 API·Gemini worker·PostgreSQL 배포와 백업/복원 절차를 준비하고 가능한 실제 검증을 완료한다.

**Architecture:** Compose는 API·worker 공통 이미지와 전용 PostgreSQL 볼륨을 관리한다. Python 표준 라이브러리 관리 CLI는 비밀 파일 준비, 설정 검사, DB 초기화, 실행, 백업/복원, timer, Funnel 공개를 구분한다. 인증서 미준비 상태에서도 이미지·DB·복원 검증은 끝내고 실제 공개는 차단한다.

**Tech Stack:** Node 24, PostgreSQL 18, Docker Compose 2.35+, Python 3, systemd user timer, Tailscale Funnel.

**Spec:** `docs/superpowers/specs/2026-09-12-pc-test-server-design.md` (2026-09-12 사용자 go 승인).

## Global Constraints

- 공개 테스트는 `APP_ENV=test`, `AUTH_MODE=toss`; 기존 mock 및 production 제한을 유지한다.
- API는 호스트 `127.0.0.1:3200`만 바인딩하고 DB 포트는 게시하지 않는다.
- 비밀은 저장소 밖, 파일 0600·디렉터리 0700. API에 Gemini 키를 제공하지 않는다.
- 기존 개발 환경·DB·사용자 파일을 보존한다. 새 브랜치는 최신 origin/main에서 시작한다.
- 토스 QR CORS는 `https://tarororo.private-apps.tossmini.com`을 사용한다.
- 실행 가능한 코드의 인증/비밀/백업 경계는 테스트하고 Compose는 실제 별도 DB로 검증한다.
- 공개 전 인증서 검증과 HTTPS 준비를 확인한다. 미완료 외부 조건은 실제 완료로 표시하지 않는다.
- 사용자 요청 없는 새 커밋·PR·유료 리소스 생성은 하지 않는다.

## Task 1: Worker 설정 분리와 이미지

**Files:** `server/src/config.ts`, `server/src/worker/main.ts`, `server/tests/config.test.ts`, `.dockerignore`, `deploy/pc-test/Dockerfile`, `deploy/pc-test/run.mjs`.

**Interfaces:** `readWorkerConfig(env) -> {databaseUrl, ai}`. Container entrypoint accepts `api|worker|migrate|seed`; each role reads only its required secret files.

- [x] 설정 테스트를 추가하고 `readWorkerConfig({DATABASE_URL:'postgresql://db/test',GEMINI_API_KEY:'test'})`가 API·mTLS 설정 없이 성공하며 빈 DB URL은 거절하는지 실패부터 확인한다.
- [x] worker 시작부를 위 설정으로 바꾸고 기존 API 설정은 유지한다.
- [x] Node 24 고정 이미지와 whitelist Docker context로 server·contracts·migration만 포함한다. 비밀 파일은 런타임에 읽는다.
- [x] `rtk proxy bash -c 'source /home/jhw/.nvm/nvm.sh; nvm use --silent; npm test; npm run typecheck'`를 server에서 실행한다.

## Task 2: Compose와 관리 CLI

**Files:** `deploy/pc-test/compose.yaml`, `.env.example`, `manage.py`, `test_manage.py`.

**Interfaces:** `python3 deploy/pc-test/manage.py prepare|build|init-db|check|start|status`. Config directory override is `TARORORO_TEST_CONFIG`; state override is `TARORORO_TEST_STATE`.

- [x] 비밀 생성 반복 시 기존 값 유지, 잘못된 권한·심볼릭 링크 거절, 누락/만료/불일치 인증서 거절을 실제 임시 파일과 OpenSSL 인증서로 테스트한다.
- [x] `prepare`는 db-password·subject-secret만 새로 만들고 GEMINI_API_KEY 환경값이 있으면 키 파일로 저장한다. 기존 파일을 덮어쓰지 않는다.
- [x] Compose에 db·api·worker와 일회성 migrate·seed 역할을 정의한다. DB healthy 의존성, restart, 로그 크기 제한, read-only 앱 파일시스템, 호스트 UID 매핑을 지정한다.
- [x] `init-db`는 DB와 migration만 시작한다. `seed`는 테스트 전용 명시 명령이다. `start`는 전체 사전 검사 뒤 API·worker를 시작한다.
- [x] `python3 -m unittest discover -s deploy/pc-test -p 'test_*.py'`, Compose `config --quiet`, 실제 이미지 빌드·별도 DB 초기화를 확인한다.

## Task 3: 백업과 복원

**Files:** `deploy/pc-test/manage.py`, `test_manage.py`, `README.md`.

**Interfaces:** `backup` returns one completed custom-format dump path; `restore-check [path]` restores to a newly named temporary database; `install-backup-timer` installs user timer/service for the current checkout.

- [x] 백업 실패 시 완료 파일·마지막 정상 백업이 보존되고, 최근 7개 성공 백업만 유지되는지 테스트한다.
- [x] `pg_dump -Fc`를 임시 파일로 받아 성공 뒤 rename한다. flock으로 겹치는 백업을 거절한다.
- [x] 복원은 UUID가 포함된 별도 DB에만 실행하고 pg_restore 오류, migration/콘텐츠 수, FK 관계를 확인한다. 정리는 생성한 임시 DB에만 한정한다.
- [x] user timer로 매일 백업, Persistent 설정, 현재 linger 상태를 확인한다.
- [x] 실제 seed DB 백업·복원, DB·worker 재시작 데이터 유지와 기존 서버 상태를 확인한다.

## Task 4: HTTPS·실기기 경계와 인계

**Files:** `deploy/pc-test/manage.py`, `deploy/pc-test/README.md`, root `README.md`, `docs/superpowers/pc-test-server-verification.md`.

- [x] `publish`는 전체 사전 검사·API ready·현재 Funnel 충돌 검사 뒤 `tailscale funnel --bg --https=443 http://127.0.0.1:3200`을 호출한다. 사용자 웹 승인이 필요하면 URL을 그대로 안내한다.
- [x] 실제 토스 인증서를 연결하고 API를 시작한다. 인증서·키 일치 및 유효기간, API ready·QR CORS·무인증 401, 토스 검증 API 응답을 확인했다. 잘못된 익명키에 대한 거절 응답이며 실제 사용자 인증 성공은 아니다.
- [x] HTTPS API 주소를 넣어 실기기 번들을 빌드·업로드한다. `20260912-2`, deployment `01a09330-7521-7d40-a99f-b764cf50c4b1`, 콘솔 `CREATED` 확인.
- [x] Funnel HTTPS를 공개하고 공개 DNS의 두 IPv4 경로에서 ready HTTP 200을 확인한다. QR CORS preflight 204와 무인증 조회 401을 확인했다. 본인 테스트 푸시가 성공했고 도구에서 반환한 테스트 링크·QR 주소를 확보했다.
- [x] 폰에서 실제 토스 익명키 인증·리딩 생성·기록 재방문을 확인한다. 사용자가 안내한 전체 확인 항목을 완료했다고 보고했다. 이후 읽기 전용 DB 집계에서 Person 2, Reading 2, `SUCCEEDED` 2를 확인했다. 실기기 관측의 근거는 사용자 확인이며 테스트 준비 플래그 `isTested=true`만으로 완료 처리하지 않았다.
- [x] 서버 단위·PostgreSQL 통합 테스트, 배포 테스트, 실제 backup/restore 결과를 문서화한다. worker E2E와 실제 토스 인증의 검증 범위를 구분한다.
- [x] 최종 diff·비밀값 누출·미완료 조건을 검토하고 사용자에게 필요한 최소 다음 조작만 보고한다.
