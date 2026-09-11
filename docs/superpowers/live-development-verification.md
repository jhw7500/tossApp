# PC / 폰 브라우저 실시간 개발 검증

검증일: 2026-09-11. 대상: `feat/backend-foundation` worktree.

## 실행 경로

루트 `npm run dev`가 Node 24.12에서 API(127.0.0.1:3100), Gemini worker, Vite(5173)를 함께 실행한다. 기존 로컬 PostgreSQL과 서버의 환경 설정을 사용한다. API와 worker는 Node watch, 화면은 Vite HMR로 갱신한다. 토스 식별만 브라우저별 개발 mock이며 AI 생성과 데이터 저장은 실제 실행이다.

최종 실행 상태는 전용 tmux 서버 `tarororo-live`, 세션 `dev`에서 유지한다. 재부팅 시 자동 시작하도록 설치한 서비스는 아니다. 접속 및 재실행 방법은 [README](../../README.md)를 따른다.

## 확인 결과

- HTTP LAN에서 `crypto.randomUUID`가 없는 상태를 실제 Chromium으로 재현했다. 개발 HTML 앞에 안전한 난수 기반 UUID 보완을 넣은 뒤 SDK mock과 사용자 초기화가 정상 동작했다. HTTPS/localhost의 기본 구현은 바꾸지 않는다.
- `127.0.0.1:5173`, `192.168.0.2:5173`에서 모바일 크기(390×844, touch) 브라우저로 초기 화면을 확인했다. 새로고침 후 사용자 식별 유지, 페이지 예외 0, 가로 넘침 없음.
- LAN 주소에서 인연 등록 → 질문/카드 세 장 선택 → Gemini 생성 성공 → 새로고침 후 결과 재조회까지 검증했다. Reading `5d2cfad4-6a65-4b38-ac67-9e6886bae87b`: `SUCCEEDED`, `current_attempt_no=1`, `ai_generated=true`, 저장된 결과 존재. 서버 재시작 뒤 DB에서도 재확인했다.
- Person 입력 화면의 placeholder를 임시 변경해 열린 페이지에 HMR이 반영되는 것을 확인했다. 작성 중인 별명이 유지됐고, 변경 원복도 재접속 없이 반영됐다.
- API와 worker의 임시 소스 변경으로 두 실행 PID가 바뀌었고 API readiness가 다시 200을 반환했다. 임시 변경은 모두 원복했다.
- 중복 실행은 포트 충돌 오류로 종료했으며 기존 프로세스를 종료하지 않았다. Ctrl+C로 이 명령이 실행한 API/worker/Vite가 모두 정리됐고 기존 PostgreSQL 포트는 유지됐다. 이후 전용 tmux에서 다시 실행했다.
- 프런트엔드 행동 테스트 18/18, typecheck, lint, 전체 `npm run build` 통과. 배포 산출물의 HTML/JS/CSS 세 파일에서 개발 보완 코드와 실제 Gemini 키가 없음을 확인했다. 서버 `.env`의 Vite 파일 요청은 403이었다.

## 확인된 범위와 제한

- 실제 안드로이드 폰에서 Tailscale subnet route `192.168.0.2/32`를 통해 `http://192.168.0.2:5173/` 접속을 확인했다. 화면 동작 검증은 개발 PC에서 같은 LAN 주소로 실행한 모바일 크기 자동 브라우저 검증이다.
- Tailscale 주소 `100.118.158.79`는 HTTP 200이어도 설치된 TDS가 `@toss/tds-mobile은 앱인토스 개발에만 사용할 수 있어요.` 오류로 초기화를 거절했다. 따라서 접속 안내에서 제외했다. TDS의 제한 코드는 수정하지 않았다.
- 기존 시험용 카드 해석 콘텐츠를 사용했다. 실제 Gemini 연결과 저장 흐름을 검증한 결과이며, 타로 원문의 품질 검수가 완료된 것은 아니다.
- 토스 네이티브 사용자 인증, 결제 및 WebView 동작을 검증한 결과는 아니다. 콘솔에 업로드된 번들에는 HMR이 적용되지 않는다.
- 기존 500 kB 이상 청크 경고는 유지된다. 이번에 새 콘솔 업로드·검수 제출·출시는 수행하지 않았다.
