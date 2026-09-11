# Tarororo 개발

현재 구현은 `feat/backend-foundation` worktree에 있습니다. 이 디렉터리의 코드를 수정해야 실행 중인 개발 화면에 반영됩니다.

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
