# PC HTTPS 테스트 서버 설계안

작성일: 2026-09-12. 상태: 사용자 go로 설계 승인 완료. 실행·공개 완료 문서가 아니다.

## 목적과 범위

사용자가 선택한 단계형 경로: 기존 `cantopsbuildserver`에서 토스 실기기 테스트를 진행하고, 검증 후 클라우드로 옮긴다. 이번 완료 기준은 테스트 번들에서 사용자 식별 검증 → Person 생성 → 질문/카드 선택 → Gemini 리딩 → 저장/재조회까지 동작하는 것이다.

제품 요구사항은 `docs/spec.pdf`와 `docs/req.txt`를 따른다. 특히 사양서 7~9쪽의 카드별 여러 해석을 제공하는 원칙, 20쪽의 소수 샘플 데이터로 선행 개발을 검증하는 기준을 유지한다. handoff는 참고 자료다. 디자인·78장 실제 콘텐츠·결제·정식 출시·유료 클라우드 자원 생성은 이번 서버 구축의 완료 기준에 포함하지 않는다.

## 확인된 현재 상태

- Docker 28.1.1과 Compose 2.35.1이 설치되어 있다. API와 Gemini worker는 이미 별도 프로세스로 구현되어 있다.
- 개발 DB `tossapp-foundation-3a44f8b2`는 PostgreSQL 18이며 호스트의 `127.0.0.1:32768`에 연결되어 있다. 테스트 배포는 별도 DB 볼륨을 사용한다.
- Tailscale은 연결 상태다. 장치 도메인은 `cantopsbuildserver.tail661d29.ts.net`이다. Serve/Funnel 설정은 비어 있고, `CertDomains`는 null이다. HTTPS 및 Funnel 사용 가능 여부는 활성화 단계에서 확인해야 한다.
- 현재 API 설정은 `local`, `test`, `production`을 구분한다. mock 인증은 loopback의 local/test에서만 허용한다. 토스 인증은 mTLS 인증서·개인키 경로가 필수다. 현재 `server/.env`에는 해당 경로가 설정되어 있지 않다.
- 프런트엔드는 SDK 3.2.0이며 배포 빌드에 HTTPS `VITE_API_BASE_URL`이 필요하다. 실기기에서는 `User.getAnonymousKey()`를 사용한다.
- 토스 로그인 설정 조회는 약관 미동의로 실패했다. 현재 앱은 `appLogin`을 사용하지 않으므로 이 결과를 익명 식별키 기능이나 mTLS 발급 불가의 근거로 해석하지 않는다. 개인 워크스페이스의 실제 인증서 발급 가능 여부는 아직 확인되지 않았다.

## 접근 방법과 선택

1. **Docker Compose + Tailscale Funnel (제안)**: 설치된 도구를 활용하고 API·worker 이미지와 DB를 함께 재현할 수 있다. 자체 도메인 구매 없이 Tailscale 도메인으로 HTTPS를 제공한다. PC 전원·네트워크와 Funnel의 대역폭 제한에 의존한다.
2. **systemd + Tailscale Funnel**: 호스트의 Node 실행 환경을 바로 사용할 수 있지만, 런타임·의존성 설치와 클라우드 이전 절차를 별도로 관리해야 한다.
3. **우선 Tailscale Serve로 비공개 HTTPS**: tailnet 연결 기기의 네트워크 확인에는 유용하다. 인터넷에서 접근할 수 있는 테스트 API가 목적이므로 최종 경로는 Funnel이다. mTLS가 준비되지 않았을 때도 mock API를 Funnel로 공개하지 않는다.

## 구성과 데이터 흐름

```text
Toss app / QR test bundle
          |
          | HTTPS :443
          v
Tailscale Funnel (TLS on cantopsbuildserver)
          |
          | HTTP 127.0.0.1:3200
          v
API container ---- mTLS ----> Toss anonymous-key verification
          |
          v
PostgreSQL 18 <----> Worker container ---- HTTPS ----> Gemini
          |
          v
Daily backup -> Separate temporary restore database (verification)
```

Compose 프로젝트 이름은 `tarororo-test`로 하고, 서비스는 `db`, `api`, `worker`, 일회성 작업은 `migrate`, `seed`, `backup`으로 구성한다.

- API와 worker는 같은 Node 24 계열 이미지를 사용한다. 구현 시 구체 버전을 고정하고 `server`의 lockfile로 의존성을 설치한다. `contracts`와 migration도 이미지에 포함한다.
- 호스트에서는 API 포트만 `127.0.0.1:3200`으로 열고, DB는 Compose 내부에서만 접근한다. 기존 개발 API 3100, Vite 5173과 분리한다. 3200의 가용성은 실행 직전에 확인한다.
- API와 worker는 자동 재시작과 종료 유예를 설정한다. DB 준비 및 migration 성공 뒤 실행하고, migration 실패 시 배포를 중단한다. 시작 시 데이터나 볼륨을 초기화하지 않는다.
- API의 `/health/ready`는 API·DB 연결만 증명한다. worker 성공 여부는 실제 작업의 완료 상태로 따로 확인한다.

## 인증·테스트 데이터·비밀값

- 공개 테스트 설정은 `APP_ENV=test`, `AUTH_MODE=toss`이다. 테스트 배포 사전 검사가 mock을 거절해야 한다. 새 `staging` 모드를 추가하거나 production의 synthetic 차단을 약화하지 않는다.
- 테스트 DB에만 기존 seed를 명시적으로 실행한다. 샘플 해석의 `synthetic_test` 표시와 응답의 `testContent`를 유지한다. 실제 타로 콘텐츠나 품질 검증 완료로 표시하지 않는다.
- 비밀값은 저장소 밖의 `~/.config/tarororo-test/`에 보관한다. 디렉터리 0700, 비밀 파일 0600을 적용하고 런타임 UID가 읽을 수 있는지 검증한다. Docker build context·이미지·번들·로그에 포함하지 않는다.
- API에는 DB 연결값, 지속 사용하는 `AUTH_SUBJECT_SECRET`, 읽기 전용 mTLS 인증서·키를 제공한다. Gemini 키는 worker에만 제공한다.
- 현재 worker는 API 공통 설정을 읽는다. worker가 실제로 필요한 DB·AI 설정만 읽도록 좁게 분리해 API 인증 비밀을 불필요하게 전달하지 않는다. 제품 API 계약은 유지한다.
- 인증서 누락·만료·키 불일치, 필수 비밀 누락, 부적절한 CORS, mock 설정이면 공개 단계로 넘어가지 않는다. 인증 오류를 공용 사용자로 대체하지 않는다.
- 현 API는 전달된 IP 헤더를 신뢰하지 않는다. Funnel 뒤에서 인증 요청 제한이 프록시 전체에 적용될 수 있음을 소수 테스터 조건에서 검증한다. 임의 `X-Forwarded-For`를 신뢰하도록 바꾸지 않는다.

## HTTPS와 앱 연결

예상 API 주소는 `https://cantopsbuildserver.tail661d29.ts.net`이다. 현재 접속 가능한 주소라고 안내하지 않으며 활성화 뒤 검증한다. API 주소는 앱 화면이 아니라 API 엔드포인트다.

- Tailscale HTTPS와 이 장치의 Funnel 권한을 활성화한다. 관리자의 웹 승인이 나타나면 사용자가 처리해야 한다. tailnet의 다른 멤버에게 불필요하게 Funnel 권한을 확대하지 않는다.
- 로컬 배포·인증 설정 검증 후 사용할 공개 명령은 `rtk proxy tailscale funnel --bg --https=443 http://127.0.0.1:3200`이다. 공개 인터넷에서 API에 접근하게 되며, HTTPS 인증서 발급은 장치 도메인을 공개 인증서 기록에 남길 수 있다. CLI의 실제 안내를 확인하고 수행한다.
- 철회 시에는 해당 443 대상만 끄며, 다른 Tailscale 설정을 일괄 reset하지 않는다. 테스트 DB·백업은 보존한다.
- 2026-08-25 이후 업로드되는 SDK 3.x 번들은 변경된 Origin을 사용한다. 이 테스트 배포의 기본 CORS는 `https://tarororo.private-apps.tossmini.com`이다. 기존 번들 검증이 필요할 때만 `https://tarororo.private-web.tossmini.com`을 명시적으로 추가한다. wildcard는 쓰지 않는다.
- HTTPS 주소를 `VITE_API_BASE_URL`에 넣어 번들을 빌드한다. 빌드와 테스트용 업로드를 구분하고, 업로드 결과의 실제 QR/스킴으로 실기기 동작을 확인한다. 정식 출시 검토 요청은 포함하지 않는다.
- 기존 폰 브라우저 개발 경로는 수정 즉시 확인하는 용도로 유지한다. 토스 QR 번들의 프런트 변경은 재빌드·재업로드가 필요하고, 테스트 API 변경은 컨테이너 재배포로 반영한다.

## 백업·로그·장애 대응

- PostgreSQL 버전에 맞는 `pg_dump`로 하루 한 번 백업한다. 완료 파일을 원자적으로 확정하고 최근 7개 성공 백업을 보관한다. 실패 시 마지막 정상 백업을 삭제하지 않는다.
- 백업은 `~/.local/share/tarororo-test/backups/`에 제한 권한으로 보관한다. 전용 systemd user timer로 예약하고, 로그아웃·재부팅 후 실행 조건을 확인한다. 필요한 linger 설정은 사용자 범위에서 적용한다.
- 최초 백업은 별도 임시 DB에 복원하여 테이블·대표 데이터·리딩 근거 관계를 확인한다. 개발/테스트 원본 DB를 덮어쓰지 않는다.
- 같은 PC의 백업은 디스크 고장에 대한 보호가 아니다. 실사용 전에는 외부 보관 대상을 정하고 비밀값 복구 및 DB 복원 절차를 검증해야 한다.
- 컨테이너 로그는 크기와 보관 개수를 제한한다. 요청 ID·오류 코드·작업 상태·처리시간만 운영 확인에 사용하며 사용자 자유문·해석 원문·세션·키는 기록하지 않는다.
- worker 종료나 Gemini 실패는 기존 lease/실패/명시적 재시도 규칙을 따른다. 자동 재시작이 AI 요청의 무제한 재시도로 이어져서는 안 된다.

## 구현 산출물과 검증

배포 정의는 `deploy/pc-test/` 아래 Dockerfile, Compose, 비밀값 없는 `.env.example`, 준비·시작·상태·백업·복원 검증 스크립트, timer 예시로 모은다. 루트 `.dockerignore`와 README에 실제 사용 명령을 연결한다. 필요한 서버 변경은 worker 설정 분리와 관측에 한정한다.

1. Compose 설정·쉘 정적 검사, 이미지 생성 및 이미지 내 비밀값 배제 확인.
2. 별도 테스트 DB migration/seed, API 준비 상태, 재시작 후 데이터 유지 확인.
3. mock·인증서·설정 오류의 공개 차단, 허용/비허용 Origin 및 인증 없는 데이터 접근 거절 검증.
4. 백업 생성·별도 DB 복원과 timer/로그 제한 검증.
5. 외부 HTTPS 응답 및 폰에서 Tailscale을 끈 네트워크의 연결 확인.
6. 토스 테스트 번들에서 실제 익명키 검증과 리딩 성공/기록 재조회. mTLS 미준비 상태의 모의 검사는 이 단계를 통과한 것으로 표시하지 않는다.

최종 보고는 준비된 배포 파일, 실제 서버 가동, 외부 연결, 토스 E2E의 완료 여부를 각각 밝힌다. 인증서나 Tailscale 관리자 설정이 미완료이면 그 단계와 필요한 사용자 조작을 정확히 남긴다.

## 클라우드 이전

검증된 API·worker 이미지와 migration을 재사용한다. 클라우드의 PostgreSQL에 백업을 복원하고, 동일한 사용자 매핑 비밀을 안전하게 이전하며, HTTPS API 주소와 앱 빌드 설정을 교체한다. 동시 쓰기를 피하도록 전환 시간을 정하고, 기존 기록 재조회와 롤백을 확인한 뒤 PC 경로를 종료한다. 공급자·요금제 선택과 자원 생성은 다음 단계다.

## 근거

- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel): HTTPS·MagicDNS·Funnel 권한 요구, 공개 범위와 제한.
- [Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel): 공개 프록시 실행 명령.
- [토스 서버 API 이용하기](https://developers-apps-in-toss.toss.im/documentation/integration/server-api): mTLS 및 날짜별 CORS Origin 변경.
- [사용자 식별키](https://developers-apps-in-toss.toss.im/documentation/common/authentication/hash-key): 익명키 발급과 mTLS 검증의 구분.
- [미니앱 테스트](https://developers-apps-in-toss.toss.im/guide/operation/toss): HTTPS·테스트 번들·QR 실행 조건.

공식 문서 확인일: 2026-09-12. 문서 MCP의 요약은 Origin 변경 안내를 빠뜨렸으므로 원문에 명시된 적용일을 기준으로 삼았다.
