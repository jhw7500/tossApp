# PC 테스트 서버

기존 개발 서버와 별도로 API·Gemini worker·PostgreSQL을 실행한다. 전제: Linux, Docker/Compose 2.35 이상, Python 3.10 이상, OpenSSL, Tailscale. Node는 이미지에 포함되어 호스트 설치에 의존하지 않는다. 명령은 저장소 루트에서 실행한다.

```text
Toss QR -> HTTPS/Funnel -> 127.0.0.1:3200 -> API -> PostgreSQL
                                                      ^
                                                      |
                                                   Worker -> Gemini
```

## 준비와 실행

```sh
rtk proxy python3 deploy/pc-test/manage.py prepare
rtk proxy python3 deploy/pc-test/manage.py build
rtk proxy python3 deploy/pc-test/manage.py init-db
rtk proxy python3 deploy/pc-test/manage.py seed
```

`prepare`는 기존 키를 유지한다. Gemini 키가 현재 셸의 `GEMINI_API_KEY`로 제공되면 별도 비밀 파일로 저장한다. 값을 터미널 명령·채팅·저장소에 적지 않는다. 나머지 필수 파일은 아래 위치에 준비한다. `.env.example`은 경로 설명용이며 스크립트가 자동으로 읽거나 실행하지 않는다.

| 파일 (`~/.config/tarororo-test/` 아래) | 용도 / 제공 대상 |
| --- | --- |
| `db-password` | 자동 생성 / DB, API, worker, DB 작업 |
| `subject-secret` | 자동 생성, 사용자 매핑을 위해 지속 보존 / API |
| `gemini-api-key` | 기존 Gemini 키 / worker |
| `toss-client.crt` | 앱인토스 발급 PEM 클라이언트 인증서 / API |
| `toss-client.key` | 해당 인증서의 PEM 개인키 / API |

설정 디렉터리는 현재 사용자 소유 0700, 각 파일은 0600이어야 한다. 암호화된 개인키는 지원하지 않는다. 발급한 인증서·키를 위 경로에 저장한 뒤 다음 명령으로 권한을 맞춘다.

경로를 재정의할 때는 저장소 밖의 전용 디렉터리를 사용한다. 상위 디렉터리를 가리키는 `..` 경로는 파일 생성 전에 거절하며, 비밀 파일과 상위 경로의 심볼릭 링크도 허용하지 않는다.

```sh
rtk proxy chmod 600 /home/jhw/.config/tarororo-test/toss-client.crt /home/jhw/.config/tarororo-test/toss-client.key
rtk proxy python3 deploy/pc-test/manage.py check
rtk proxy python3 deploy/pc-test/manage.py start
```

`check`는 비밀값·인증서 유효기간/키 일치·CORS·DB 비공개·서비스별 비밀 분리를 확인한다. 인증서의 토스 등록 여부는 실제 토스 식별키 검증으로 확인해야 한다. `start`는 migration 성공 후 API와 worker를 실행한다. 인증서가 준비되기 전에는 다음 명령으로 worker만 실행할 수 있다.

```sh
rtk proxy python3 deploy/pc-test/manage.py start-worker
rtk proxy python3 deploy/pc-test/manage.py status
```

Compose 프로젝트는 `tarororo-test`, 데이터 볼륨은 `tarororo-test_database`다. DB 포트는 호스트에 게시하지 않는다. API 포트는 `127.0.0.1:3200`이며 기존 개발용 API 3100·Vite 5173·DB와 분리된다. API·worker의 파일시스템은 읽기 전용이고, 필요한 비밀 파일만 읽기 전용으로 연결한다. 재시작 정책은 `unless-stopped`다.

DB는 별도 테스트 데이터만 넣는다. `seed`는 자동 시작 단계가 아니라 명시적인 시험 콘텐츠 입력 명령이며, 실제 타로 원문이나 기존 운영 데이터 이전으로 취급하지 않는다.

## 백업과 복원 확인

```sh
rtk proxy python3 deploy/pc-test/manage.py backup
rtk proxy python3 deploy/pc-test/manage.py restore-check
rtk proxy python3 deploy/pc-test/manage.py install-backup-timer
rtk proxy systemctl --user list-timers tarororo-test-backup.timer
```

백업은 `~/.local/share/tarororo-test/backups/`에 저장한다. PostgreSQL custom dump를 성공한 뒤에만 완료 파일로 확정하고 최근 7개를 유지한다. 실패하면 마지막 정상 백업을 보존한다. 복원 확인은 무작위 이름의 별도 DB를 만들고, 스키마·데이터·제약 복원 및 테이블별 행 수를 검사한 뒤 그 임시 DB만 삭제한다. 특정 파일은 `restore-check /절대경로/파일.dump`로 지정한다.

`restore-check`는 시험 콘텐츠를 넣은 DB를 기준으로 한다. 선택 가능한 카드가 3장 이상이고 각 카드에 활성 한국어 해석 버전이 연결되어 있어야 성공한다. migration 이력만 있고 콘텐츠가 빠진 덤프는 실패하며, 아직 Person·Reading이 없는 초기 시험 DB는 허용한다. 이 검사는 복원 가능성·최소 콘텐츠·DB 제약을 확인한다. 백업 시점의 전체 행 수와 대조하는 검사는 아니므로 일부 사용자 데이터 누락까지 판별하지는 않는다.

timer는 호스트 시간대 기준 매일 04:00부터 최대 5분 이내에 실행하며 놓친 실행을 보충한다. `Linger=yes`여야 로그아웃 후에도 user manager가 유지된다. 현재 PC는 이미 설정되어 있다. 설치된 unit은 현재 checkout의 관리 스크립트를 참조하므로 worktree 이동/삭제 전에 새 경로에서 다시 설치하거나 timer를 해제해야 한다. 사용자 unit의 재부팅 후 실행과 Docker 시작은 실제 호스트 부팅 조건에 의존한다.

같은 디스크의 백업으로 디스크 고장을 복구할 수는 없다. 클라우드 이전/실사용 전에 외부 백업 보관과 매핑 비밀값 복구 절차를 준비한다.

## HTTPS 공개와 토스 연결

`start`가 성공한 뒤에만 공개한다.

```sh
rtk proxy python3 deploy/pc-test/manage.py publish
```

이 명령은 인증 조건과 실행 중인 API를 확인한 뒤 `tailscale funnel --bg --https=443 http://127.0.0.1:3200`을 실행한다. Tailscale HTTPS/Funnel 관리자 승인이 필요하면 CLI에 표시된 웹 링크에서 진행한다. 기존 Serve/Funnel 구성이 있으면 변경하지 않고 중단하므로 먼저 설정을 확인한다. 45초 내 명령이 완료되지 않아도 Tailscale 설정이 변경되었을 수 있으므로 재시도 전에 `rtk proxy tailscale funnel status`를 확인한다.

실행 중인 API의 `ALLOWED_ORIGINS`도 실제 컨테이너에서 검사한다. 현재 Compose 파일을 수정했더라도 실행 중인 컨테이너의 Origin이 승인된 QR Origin과 다르면 공개를 거절한다.

웹 활성화 뒤 `Access denied: serve config denied`가 나오면 로컬 사용자에게 Tailscale 설정 권한이 없는 것이다. API 검사가 통과했고 기존 공개 설정이 비어 있음을 확인한 상태에서 서버 터미널의 사용자가 `rtk proxy sudo tailscale funnel --bg --https=443 http://127.0.0.1:3200`을 실행한다. 비밀번호는 서버의 sudo 프롬프트에만 입력한다. 성공 후에는 기존 구성과 실제 HTTPS 응답을 확인하며 `publish`를 다시 실행해 설정을 덮어쓰려 하지 않는다.

예상 주소는 `https://cantopsbuildserver.tail661d29.ts.net`이다. 실제 활성화 후 `/health/ready`가 정상인지 폰에서 Tailscale을 끄고 확인한다. 주소 자체는 API이므로 앱 화면이 뜨는 URL이 아니다. 공개 중인 프록시를 종료하려면 현재 대상이 위 API인지 확인한 뒤 `rtk proxy tailscale funnel --https=443 off`로 해당 리스너만 끈다.

프런트 빌드 시 `VITE_API_BASE_URL`에 위 HTTPS 주소를 지정하고 `ai-tarot`에서 `npm run build`를 실행한다. 생성된 `.ait`를 테스트용으로 업로드한 뒤 실제 QR/스킴을 사용한다. 기본 CORS는 `https://tarororo.private-apps.tossmini.com`이며 정식 출시용 Origin을 추가하지 않는다. [토스 Origin 변경 안내](https://developers-apps-in-toss.toss.im/documentation/integration/server-api)

화면 즉시 확인은 기존 `http://192.168.0.2:5173/` 개발 경로를 사용한다. 토스 QR 번들은 프런트 변경 때마다 빌드·업로드가 필요하다. API/worker 변경은 `build` 후 `start`로 재배포하며, 인증서 준비 전 worker만 갱신할 때는 `build` 후 `start-worker`를 사용한다.

## 검증과 상태 확인

```sh
rtk proxy python3 -m unittest discover -s deploy/pc-test -p 'test_*.py'
rtk proxy python3 deploy/pc-test/manage.py status
rtk proxy docker logs --tail 50 tarororo-test-worker-1
rtk proxy journalctl --user -u tarororo-test-backup.service -n 30 --no-pager
```

컨테이너 로그는 `local` 드라이버로 파일당 10 MiB, 3개를 유지한다. `/health/ready`는 API·DB 연결 상태이며 worker나 토스 인증 성공을 나타내지 않는다. 프록시 뒤의 인증 요청 제한은 현재 소수 테스터가 공유할 수 있다(프록시 IP당 분당 10회). 전달 IP 헤더를 무조건 신뢰하도록 변경하지 않는다.

실제 Gemini 호출을 한 번 실행하는 서버 연결 검증은 아래와 같다. 합성 Person·Reading 한 건을 테스트 DB에 남기고 비용이 발생할 수 있다. 인증은 네트워크 리스너 없는 내부 fixture를 사용한다. **토스 mTLS·HTTPS·폰 검증을 대신하지 않는다.**

```sh
rtk proxy bash -c 'docker exec -i tarororo-test-worker-1 node --input-type=module < deploy/pc-test/verify-reading.mjs'
```

현재 검증과 남은 조건은 [검증 기록](../../docs/superpowers/pc-test-server-verification.md)에 기록한다. Docker Compose 명령을 직접 실행해야 할 때도 `manage.py`가 사용하는 구성/UID/경로와 동일한 조건을 유지한다. 기존 키를 새로 생성하거나 `down -v`로 볼륨을 삭제하는 작업은 일반 재배포 절차가 아니다.

공식 기반: [Node 이미지](https://hub.docker.com/_/node), [PostgreSQL 이미지](https://hub.docker.com/_/postgres), [Funnel](https://tailscale.com/docs/features/tailscale-funnel), [토스 익명키 검증](https://developers-apps-in-toss.toss.im/documentation/common/authentication/hash-key).
