# Tarororo 개발

2026-09-12 기준 인연 등록·수정, 질문과 카드 3장 선택, AI 리딩 생성·재시도·기록 조회가 구현됐습니다. PC 테스트 서버의 HTTPS·토스 인증 연결과 백업/복원을 검증했고, 토스 앱의 전체 흐름은 사용자가 확인했습니다. 자세한 근거와 테스트 링크는 [PC 테스트 서버 검증](docs/superpowers/pc-test-server-verification.md)에 있습니다.

실제 타로리더 원문과 품질 평가, 최종 UI·카드 연출·브랜드, 과금 정책 및 출시 준비는 남아 있습니다. 현재 합성 콘텐츠의 성공 결과는 실제 타로 해석 품질의 합격을 뜻하지 않습니다. 요구사항의 기준은 `docs/req.txt`와 `docs/spec.pdf`이며, `docs/ai-tarot-cli-handoff.md`는 사양서 없이 작성한 초기 참고 자료입니다.

## 기능별 작업과 반영 경로

기능 세션은 각 작업트리에서 수정하고 PR로 통합합니다. 아래 경로는 이 개발 PC에서 사용하는 구성이며 저장소의 필수 디렉터리 구조는 아닙니다. 자기 세션의 코드는 해당 작업트리에서 실행해야 확인할 수 있습니다.

| Session | Worktree under `.worktrees/` | Scope |
| --- | --- | --- |
| Frontend | `session-frontend` | `ai-tarot/src/` |
| Backend / AI | `session-backend-ai` | `server/src/ai/`, `server/src/readings/`, `server/src/worker/` |
| Content | `session-content` | `content/`, `scripts/content/`, `docs/content/` |
| Integration | `session-integration` | `contracts/`, migrations, `.github/`, `deploy/` |

공통 파일 변경과 테스트 서버 재배포는 통합 세션에서 조정합니다. 다른 세션의 변경을 시험하려고 기존 작업트리의 브랜치를 임의로 전환하지 마세요. `main` 병합만으로 실행 중인 개발 서버나 토스 테스트 번들이 갱신되지는 않습니다.

```text
Feature worktree -> local test -> PR + CI + review -> main
                                                      |
                                     +----------------+----------------+
                                     v                                 v
                              API/worker deploy               .ait build + upload
```

## 브라우저에서 바로 확인하기

공용 개발 서버는 아래 worktree의 코드를 사용합니다. 기능 세션의 작업트리에서 저장한 변경은 이 서버에 자동 반영되지 않습니다. 이미 실행 중이면 같은 포트로 다시 시작할 필요가 없습니다.

```sh
cd /home/jhw/ai/opencode/projects/tossApp/.worktrees/backend-foundation
nvm use
npm run dev
```

한 명령으로 Vite 화면, PostgreSQL API, 실제 Gemini worker를 실행합니다. `server/.env`의 로컬 DB 설정과 서버용 `GEMINI_API_KEY`가 필요합니다. 셸에 설정한 환경변수가 `.env`보다 우선하며 API 키는 프런트엔드 프로세스에 전달하지 않습니다. 의존성이 없으면 `ai-tarot/`와 `server/`에서 각각 `npm ci`를 먼저 실행합니다. DB 초기 설정은 [서버 안내](server/README.md)를 참조하세요. 이 실행 명령은 DB를 초기화하거나 기존 콘텐츠를 변경하지 않습니다.

| 접속하는 곳 | 현재 개발 PC의 주소 |
| --- | --- |
| 개발 PC 브라우저 | http://localhost:5173/ |
| 같은 Wi-Fi의 폰 브라우저 | http://192.168.0.2:5173/ |

폰에서는 Chrome 또는 Safari 주소창으로 여세요. Wi-Fi 주소는 IP가 바뀌면 달라지므로 실행 로그의 Network 주소를 확인하세요. PC가 켜져 있고 개발 명령이 실행 중이어야 합니다. LTE/5G에서 사설 Wi-Fi 주소로 접속할 수는 없습니다. 현재 설치된 TDS는 Tailscale의 `100.x` 주소에서 초기화를 거절합니다. Vite의 Network 목록에 표시되어도 폰 접속 주소로 사용하지 마세요.

Tailscale로 접속할 때는 개발 PC에서 화면 주소 하나를 subnet route로 광고하고 Tailscale 관리 페이지에서 승인합니다. 현재 환경은 `192.168.0.2/32`가 승인되어 있어, 폰의 Tailscale을 켠 상태에서도 `http://192.168.0.2:5173/`을 사용합니다. 개발 PC의 Wi-Fi 주소가 바뀌면 광고·승인 주소도 함께 갱신해야 합니다.

```text
PC / phone browser
        |
        v
Vite :5173 -- /api --> API 127.0.0.1:3100 --> PostgreSQL
  ^                                            ^
  | HMR                                        |
source save                              Gemini worker
```

- 화면 파일 저장: 브라우저에서 HMR로 즉시 반영됩니다. 변경 종류에 따라 전체 새로고침이 발생할 수 있습니다.
- API/worker 파일 저장: 해당 Node 프로세스가 자동 재시작됩니다. API 응답은 다음 요청에 반영되며, 이미 저장된 리딩은 유지됩니다. AI 처리 중 worker를 수정했다면 실패한 리딩의 재시도 버튼으로 다시 실행하세요.
- `server/.env` 또는 실행 스크립트 수정: `Ctrl+C` 후 `npm run dev`로 다시 실행합니다.
- 종료: 실행 터미널에서 `Ctrl+C`. 이 명령이 띄운 세 프로세스만 종료하고 PostgreSQL은 유지합니다.
- 포트 충돌: 기존 프로세스는 건드리지 않고 오류를 출력합니다. 필요하면 `TARORORO_WEB_PORT=5174 TARORORO_API_PORT=3101 npm run dev`로 바꿉니다.
- PC에서만 열기: `TARORORO_DEV_HOST=127.0.0.1 npm run dev`.

브라우저마다 별도 테스트 사용자입니다. 주소가 달라지거나 브라우저 저장소를 지우면 다른 사용자로 보입니다. 개발 모드에서만 브라우저 식별 mock과 HTTP 접속용 UUID 보완을 적용합니다. 리딩에는 실제 Gemini가 호출되고 비용이 발생할 수 있으며, 현재 카드 해석 원문은 검수된 콘텐츠가 아닌 시험 데이터입니다.

이 경로는 신뢰하는 Wi-Fi 내부 개발용입니다. Vite를 공유기 포트 포워딩이나 공개 터널로 노출하지 마세요. 토스 로그인·결제·네이티브 동작은 별도로 `.ait`를 빌드하고 콘솔의 QR 테스트로 확인합니다. 콘솔에 올린 정적 번들은 저장만으로 갱신되지 않습니다. [공식 SDK 3.x 테스트 환경](https://developers-apps-in-toss.toss.im/documentation/integration/sdk-3.x)

현재 켜 둔 서버는 전용 tmux 세션에서 실행 중입니다. 실행 로그를 보거나 종료하려면 아래 명령으로 연결하세요. `Ctrl+B`, `D`를 순서대로 누르면 서버를 유지한 채 빠져나오고, `Ctrl+C`는 개발 서버를 종료합니다.

```sh
tmux -L tarororo-live attach -t dev
```

개발 경로의 검증 결과는 [실시간 테스트 환경 검증](docs/superpowers/live-development-verification.md)에 기록합니다.

## 독립적인 PC 테스트 배포

토스 QR 테스트용 API·worker·전용 PostgreSQL과 백업/복원은 [PC 테스트 서버 안내](deploy/pc-test/README.md)를 따른다. API는 호스트의 `127.0.0.1:3200`에 바인딩하고, 실제 토스 mTLS 인증서를 준비한 뒤 Tailscale Funnel로 HTTPS를 연결한다. 기존 개발 환경과 테스트 배포는 DB와 실행 프로세스가 분리되어 있다. 현재 완료 여부는 [검증 기록](docs/superpowers/pc-test-server-verification.md)에 있다.

기존 `.worktrees/backend-foundation` 경로는 공용 개발 서버와 백업 timer가 참조하므로 PR 병합 후에도 유지합니다. PC 테스트 서버의 HTTPS 주소는 API 주소이며, 폰에서 화면을 여는 방법은 검증 기록의 토스 테스트 링크 또는 QR을 따릅니다.

## 자동 검증

[CI](.github/workflows/ci.yml)는 PR과 `main` push에서 다음 명령을 실행합니다. 로컬에서는 Node `.nvmrc` 버전과 각 패키지의 기존 lockfile로 의존성을 준비한 뒤 해당 디렉터리에서 실행합니다.

| Check | Directory | Command |
| --- | --- | --- |
| Frontend | `ai-tarot/` | `npm test` / `npm run typecheck` |
| Server unit / types | `server/` | `npm test` / `npm run typecheck` |
| PostgreSQL integration | `server/` | `npm run test:integration` |
| Deployment unit | repository root | `python3 -B -m unittest discover -s deploy/pc-test -p test_manage.py` |

이 명령에는 `rtk` 설치가 필요하지 않습니다. 이 개발 PC의 에이전트 세션은 로컬 RTK 지침에 따라 명령 앞에 `rtk proxy`를 붙이며, GitHub CI와 일반 checkout에서는 표의 명령을 직접 실행합니다.

PostgreSQL 통합 테스트에는 전용 테스트 DB의 `TEST_DATABASE_URL`이 필요합니다. 각 fixture가 고유 schema를 만들고 정리하므로 실제 서비스 DB를 지정하지 않습니다. CI는 임시 PostgreSQL 서비스를 사용하고 토스 인증서나 실제 AI 키 없이 검증합니다. 배포 도구의 실제 백업/복원 통합 시험과 토스 실기기 검증은 이 CI에 포함되지 않습니다.
