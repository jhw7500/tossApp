# PC 테스트 서버 검증

검증일: 2026-09-12 KST. 브랜치: `feat/pc-test-server`, 기준 커밋: `28bde73` (PR #2 반영 main).

## 현재 결과

PC 테스트 환경 구축과 실기기 검증을 완료했다. 실제 API는 `127.0.0.1:3200`에서 healthy이며 Funnel 공개 HTTPS의 ready·CORS·무인증 차단 검증을 통과했다. 사용자가 토스 테스트 번들에서 안내한 전체 확인 항목을 완료했다고 보고했다. 실기기 동작은 사용자 확인을 근거로 기록하며, 별도 읽기 전용 DB 집계에서도 기존 합성 리딩에 더해 성공 리딩이 1건 증가했다. 최종 서비스 콘텐츠·디자인 완성과 출시 검수는 이 테스트 환경 구축의 완료 범위에 포함하지 않는다.

```text
Image + dedicated DB + worker    PASS
Gemini -> saved reading/history PASS (in-process auth fixture)
Backup -> restore -> restart    PASS
Toss certificate pair + API     PASS
Toss API with invalid anon key  HTTP 200 / FAIL / 4010
Toss test bundle compile        CREATED (20260912-2)
Funnel + public HTTPS          PASS
Public QR CORS + auth rejection PASS
Toss test link + self push     READY
Toss phone authentication/E2E  PASS (user confirmed)
Post-phone database check     2 readings / 2 SUCCEEDED
```

## 검증 증거

- 변경 전 서버 단위 29개 통과. worker 설정 분리 뒤 단위 30개, TypeScript 검사 통과.
- 기존 PostgreSQL 통합 테스트 36개 통과. 테스트마다 고유 schema를 사용했다.
- 배포 Python 테스트 10개 통과: 기존 비밀 보존, 소유/권한/심볼릭 링크, 인증서·키 일치와 만료, mock·wildcard·DB 공개·서비스 간 비밀 혼입 차단, 백업 실패·빈 파일·회전.
- Node `24.21.0-bookworm-slim` 고정 digest로 이미지 빌드 성공. DB는 검증된 PostgreSQL 18 이미지 digest를 고정했다.
- 이미지에 런타임 비밀·`.env`·프런트엔드·`.git`가 없고 contracts와 migration이 포함됨을 확인했다. API/worker별 비밀 연결에서 Gemini 키가 worker에만 연결됨을 확인했다.
- 실제 Compose 실행에서 tmpfs YAML 쉼표가 배열 항목으로 나뉘는 오류를 발견해 인용 문자열로 수정했다. 수정 뒤 migration·seed·worker 실행 성공.
- 독립 볼륨 `tarororo-test_database`에 migration 3개, 카드 3개, interpretation version 15개 생성.
- 실제 Gemini 리딩 ID: `06aa87a0-4480-468b-855b-e0d71cc9e487`. `SUCCEEDED`, `aiGenerated=true`, `testContent=true`. 합성 Person 생성·카탈로그 조회·리딩 접수·결과/기록 재조회 성공.
- 위 검증은 네트워크 리스너 없는 내부 인증 fixture를 사용했다. 실제 토스 익명키나 mTLS 검증으로 계산하지 않는다.
- 별도 임시 API 컨테이너를 `127.0.0.1:3201`에서 실행해 ready·QR Origin preflight·무인증 401·Gemini 키 미연결을 확인했다. 인증서는 임시 자체서명 fixture였고 토스 인증을 요청하지 않았다. 컨테이너·인증서를 정리했으며 실제 배포 설정에 넣지 않았다.
- 최초 백업과 systemd service를 통한 백업 생성 성공. 백업 파일은 0600, 디렉터리는 0700이다.
- 두 백업 모두 별도 임시 DB에 복원했다. migration 3, 카드 3, Person 1, Reading 1, interpretation version 15를 확인했고 pg_restore가 제약조건을 재검증했다. 검증 후 임시 DB는 0개다.
- 이 작업의 DB와 worker만 재시작했다. Person 1, Reading 1, 성공 리딩 1이 유지됐다. 미완료 작업은 0개다.
- backup service `Result=success`, `ExecMainStatus=0`. unit 정적 검사 통과, timer enabled, `Linger=yes`. 다음 예약은 2026-09-13 04:00~04:05 KST다. 호스트 전체 재부팅은 수행하지 않았다.
- 발급받은 인증서·개인키를 `~/.config/tarororo-test/`에 현재 사용자 소유 0600으로 복사했다. `manage.py check`로 유효기간·키 일치와 배포 설정을 확인한 뒤 `start` 성공, API healthy 확인.
- 다운로드 원본은 주 checkout의 `docs/mTLS_인증서_20260912/`에 보존했다. 원본이 root 소유여서 비대화형 sudo 권한 변경은 불가했다. 현재 사용자 소유 상위 `docs`를 0700으로 제한했고, 공통 Git `info/exclude`로 원본 경로를 제외했다. 이 브랜치 `.gitignore`에도 `/docs/mTLS_*/`를 추가했다. Git 추적 중인 인증서·개인키는 없다.
- 실제 API에서 ready HTTP 200, QR Origin preflight HTTP 204, 무인증 Person 조회 HTTP 401 확인.
- API 컨테이너의 실제 인증서로 토스 익명키 검증 API를 호출해 HTTP 200, `resultType=FAIL`, `errorCode=4010`을 받았다. 의도적으로 유효하지 않은 연결 확인용 키를 사용했으므로 이 요청 자체는 토스 API 응답 수신까지만 검증한 것이다. 이후 실제 인증을 포함한 폰 동작은 아래 사용자 확인으로 별도 기록한다.
- `VITE_API_BASE_URL=https://cantopsbuildserver.tail661d29.ts.net`으로 프런트 타입 검사·Vite·AIT 빌드를 통과했다. 프런트 산출물에서 해당 주소와 런타임 비밀값 미포함을 확인했다. 번들 크기는 429,379 bytes다.
- 콘솔 OAuth로 `.ait` PUT HTTP 200, `bundle_upload_complete` 성공, `bundle_list`에서 deployment `01a09330-7521-7d40-a99f-b764cf50c4b1`, 버전 `20260912-2`, SDK `3.2.0`, `CREATED` 확인. 검수 요청·출시는 하지 않았다.
- `manage.py publish`는 `Funnel is not enabled on your tailnet`과 활성화 링크를 안내한 뒤 45초 제한으로 종료했다. 이후 `tailscale funnel status`는 `No serve config`, `serve status --json`은 `{}`였다. 실패 뒤 활성화되었다고 가정하지 않았다.
- 사용자 웹 활성화 완료 후 재실행한 `manage.py publish`는 `Access denied: serve config denied`를 반환했다. 안내된 동일 Funnel 명령을 `sudo -n`으로 실행했으나 `sudo: a password is required`로 종료했다. 사용자가 서버 터미널에서 해당 명령을 실행한 뒤 다음 검증을 진행했다.
- `tailscale serve status --json`에서 HTTPS 443의 유일한 `/` 대상이 `http://127.0.0.1:3200`, 해당 호스트의 `AllowFunnel=true`임을 확인했다. `funnel status`도 공개 활성화를 표시했다.
- 시스템 DNS는 Tailscale 사설 IP를 반환하므로 HTTPS 기본 접속만으로 공개 경로 검증을 대신하지 않았다. 공개 DNS가 반환한 Funnel IPv4 두 주소 각각에 `curl --resolve`로 연결하고 원래 호스트명의 TLS 검증을 유지해 ready HTTP 200을 확인했다. 공개 경로의 QR preflight HTTP 204와 무인증 Person HTTP 401도 확인했다. 별도 웹 도구의 외부 열기는 도구 제한으로 실패해 외부 관측 증거로 사용하지 않았다.
- HTTPS 검증 후 해당 deployment를 지정한 `bundle_test_push`가 성공했고 도구에서 본인용 `privateLink`와 `consoleTestUrl`을 반환했다. `isTested=true`는 테스트 환경 준비 완료 표시이며 실제 폰 테스트 완료로 계산하지 않는다.
- 사용자에게 Tailscale을 끈 상태에서 대상 추가·질문/카드 선택·리딩 생성·기록 재방문을 요청했고, 사용자가 "다 확인했다"고 응답했다. 해당 범위의 실제 토스 앱 확인 완료를 사용자 보고로 기록한다. 인증 성공 응답이나 폰 네트워크 캡처를 에이전트가 직접 관측한 것은 아니다.
- 사용자 확인 뒤 읽기 전용 집계: sessions 4, persons 2, readings 2, `SUCCEEDED` 2. 기존 검증 기준은 persons 1, readings 1이었다. 개인 이름·질문·익명키·세션 토큰·리딩 본문은 조회하지 않았다. API·DB healthy, HTTPS ready, 백업 timer enabled를 재확인했다.

## 유지 중인 자원

| 자원 | 상태 |
| --- | --- |
| `tarororo-test-db-1` | 실행·healthy, 호스트 포트 게시 없음 |
| `tarororo-test-worker-1` | 실행, 자동 재시작 설정 |
| 실제 API `127.0.0.1:3200` | 실행·healthy, `AUTH_MODE=toss` |
| `tarororo-test_database` | Person 2, Reading 2, 모두 `SUCCEEDED` |
| `~/.config/tarororo-test/` | DB 비밀·매핑 비밀·Gemini 키·토스 인증서/개인키, 제한 권한 |
| `~/.local/share/tarororo-test/backups/` | 성공 백업 2개, 보관 한도 7개 |
| `tarororo-test-backup.timer` | 매일 백업 예약 |
| Tailscale Funnel | HTTPS 443에서 API 3200 공개, 두 공개 IPv4 경로 검증 |
| 토스 테스트 번들 `20260912-2` | `CREATED`, 실제 폰 테스트 사용자 확인 완료, 미출시 |

## 완료 범위와 다음 작업

발급받은 PEM 클라이언트 인증서와 해당 개인키를 아래 서버 경로에 연결했다:

```text
/home/jhw/.config/tarororo-test/toss-client.crt
/home/jhw/.config/tarororo-test/toss-client.key
```

폰 동작 확인까지 완료했으므로 이 구현 계획의 테스트 환경 구축 항목은 모두 완료다. 사용자 계속 진행 지시에 따라 서버 구성 변경의 커밋·PR·리뷰를 진행한다. 서비스 전체는 최종 콘텐츠·디자인 및 출시 준비가 남아 있다. 실기기 테스트 완료 확인을 번들 검수 요청 지시로 간주하지 않는다. 기존 Funnel 설정은 덮어쓰거나 `manage.py publish`로 반복 공개하지 않는다. 아래 링크는 같은 번들 재확인에 사용할 수 있다.

- 폰 테스트 링크: `intoss-private://tarororo?_deploymentId=01a09330-7521-7d40-a99f-b764cf50c4b1&host=appsInTossHost`
- PC 테스트 QR: `https://apps-in-toss.toss.im/workspace/93125/mini-app/75257/app-build?testDeploymentId=01a09330-7521-7d40-a99f-b764cf50c4b1&testVersionName=20260912-2`

토스 로그인 약관은 현재 익명키 방식의 필수조건으로 가정하지 않는다. 사용자가 콘솔에서 인증서를 발급해 제공했다. 앱 정보 검토는 이전 반려 후 현재 `APPROVED`다. 최근 `miniapp_get`에서 한국어 이름 `타로로`, 영문 이름 `Tarororo`, `appType=NON_GAME`, 카테고리 `생활 > 콘텐츠 > 운세`, 아이콘 등록을 확인했다. 운영 상태는 출시 전 `PREPARE`이며 앱 정보 승인과 번들 검수·출시를 구분한다. 이 작업에서 앱 정보를 수정하거나 검토를 요청하지 않았다.

사용·재배포·백업·중단 방법은 [PC 테스트 서버 안내](../../deploy/pc-test/README.md)를 따른다. 이 기록은 `feat/pc-test-server` 변경의 구현·실기기 검증 근거이며 인증서·개인키·DB 백업은 Git에 포함하지 않는다.
