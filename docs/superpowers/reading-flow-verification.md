# 리딩 선행 개발 검증 기록

기준 문서는 `docs/req.txt`와 `docs/spec.pdf` 13·18·20쪽이다. 카드별 복수 원문을 바탕으로 Person 생성부터 AI 결과 저장·재조회까지 연결한다. 최종 UI·카드 연출·브랜드와 실제 리더 원문 평가는 후속 단계다.

## 서버와 실제 AI

2026-09-11, Node 24.12.0과 로컬 PostgreSQL 18에서 검증했다. 기존 DB에는 003 migration만 추가했으며 기존 9개 테이블의 57개 레코드는 원래 필드의 해시와 개수를 비교해 보존을 확인했다. 통합 테스트와 아래 실제 AI 검증은 별도 테스트 스키마를 사용했다.

단위 테스트 29개와 PostgreSQL 통합 테스트 36개가 통과했다. 요청 중복·소유권·스냅샷·원문 버전·작업 선점과 만료·수동 재시도·늦은 결과 거절·worker 종료 시 진행 중인 작업 정리를 포함한다. 잘못된 AI 출력은 실패로 저장하고, 명시적 재시도 후 같은 리딩·입력·후보 원문으로 성공하는 동작도 검증했다. 설정 오류와 정책상 거절은 재시도하지 않으며, 자동 AI 재호출은 없다. 자동 테스트는 외부 AI를 호출하지 않는다.

별도 실제 연결 검증은 `server/src/worker/main.ts`를 실행해 API 접수, Gemini 생성, DB 저장, API 재조회를 수행했다.

| Check | Observed result |
| --- | --- |
| Provider / model | Gemini / gemini-3.1-flash-lite |
| Reading | 43339097-c1e3-4ec8-8a80-c7505582b3e6 |
| Completion | SUCCEEDED; 5,642 ms; 1 attempt |
| Cards / independent sources | 3 / 9 |
| Selected evidence | 8 exact source ID/version pairs |
| Token usage | input 1,381; output 1,128; total 2,509 |
| Provenance | aiGenerated=true; testContent=true |
| Same-key replay | HTTP 200; same Reading; one attempt |
| New service session | same result and Person history retrieved |
| Persistence | result JSON and selected source ID/version pairs matched |
| Worker shutdown | SIGTERM; exit 0 |

원문은 검증용으로 직접 작성한 `synthetic_test` 문장이다. 위 결과는 실제 AI 통신과 저장·근거 연결 증거이며, 타로리더 원문 충실도 평가를 대체하지 않는다. 최종 모델 선정도 별도다.

## 화면 검증

기존 TDS 기반 검증용 화면에서 인연 등록·수정, DB 질문과 서로 다른 카드 세 장 선택, 생성 상태, 결과, 기록 재조회를 확인했다. 320·390·480px에서 가로 넘침과 작은 터치 영역은 없었다. 과거 리딩에는 변경 전 인연 정보가 그대로 표시됐다.

실패한 리딩은 수동 재시도로 같은 Reading의 두 번째 시도에서 성공했다. 서버가 접수한 뒤 응답만 잃은 요청은 새로고침 후 같은 본문과 키로 재전송됐으며, DB의 Reading과 시도는 각각 한 건이었다. 동시 만료 응답에는 재인증을 한 번만 수행했다. 조회 연결 오류의 명시적 복구와 완료 후 주기적 조회 중지도 검증했다.

응답 유실 뒤 실제 서비스 세션을 만료시키고 인증 API의 401·429 오류를 각각 주입한 브라우저 검증도 통과했다. 인증 실패 동안 원래 요청을 유지한 뒤 같은 본문·키로 복구했고, 각 경우 리딩과 생성 시도는 각각 한 건이었다. 인증 오류 때문에 중복 생성 방지 키를 버리지 않는다.

수정 충돌 시 작성 중인 별명·관계·상황을 유지하고 최신 서버 내용을 표시한다. 작성 내용을 최신 버전에 저장하거나 최신 내용을 입력란에 적용하는 두 선택을 실제 DB로 검증했다. 생성 응답을 잃은 뒤 같은 화면에서 질문을 수정한 경우에도 이전 요청 확인 동작이 원래 본문과 키를 재사용하고 올바른 인연의 결과로 이동했다. Reading과 시도는 각각 한 건이며 브라우저 실행 오류는 없었다.

브라우저의 성공·실패 재현에는 `aiGenerated=false`인 별도 시험 worker를 사용했다. 실제 Gemini 검증은 위 표의 별도 실행이다. 프런트엔드 행동 테스트 16개와 타입 검사·lint·빌드를 통과했고, 생성한 `.ait`는 428,653바이트다. 실제 서버 비밀값과 dist·원본 ZIP·압축 해제한 번들 항목 9개를 비교해 일치가 없었다. 운영 번들에 공개 HTTPS API 설정이 없으면 API 요청과 개발용 식별을 수행하지 않고 연결 불가 화면을 표시했다.

본문·설명 글자는 15px 이상, 보조 메타데이터는 13px 이상이다. 주 버튼의 실제 색과 흰 글자의 대비는 7.557:1이며 시스템 본문 서체와 공개 Tossface 이모지 서체를 사용한다. 약 1.27MB의 JavaScript 청크에 대한 Vite 경고는 남아 있어 실제 기기에서 성능을 확인한 뒤 분리 여부를 정한다.

인연과 리딩 기록은 처음 100개를 표시하고, 서버가 `nextCursor`를 반환하면 화면의 `더 보기`로 다음 기록을 중복 없이 이어 붙인다. 추가 조회가 실패해도 이미 표시한 기록과 cursor를 유지해 같은 요청을 다시 시도할 수 있다.

## 로컬 실행과 남은 외부 검증

서버 실행과 별개 터미널의 worker 실행에는 `server/README.md`를 따른다. API 프로세스는 AI 키 없이 시작할 수 있고, worker만 `GEMINI_API_KEY`를 읽는다. API·DB·worker 설정은 서버 환경변수, 공개 API 주소는 프런트엔드 빌드 설정으로 분리한다.

실제 토스 사용자 식별·HTTPS 서버 통신·실기기 리딩 재접속은 로컬 검증에 포함되지 않았다. tarororo용 mTLS 인증서와 HTTPS 운영 환경이 필요하다. 콘솔 OAuth 인증은 이 서버 인증서를 대신하지 않는다.

2026-09-11에 현재 소스를 다시 빌드해 콘솔 워크스페이스 `tarotaro`의 미니앱 `tarororo`로 테스트 번들을 올렸다. 버전은 `20260911-1`, deployment ID는 `01a0905f-b3b7-77e8-8260-84c36d1d13b6`, 컴파일 상태는 `CREATED`, SDK는 3.2.0이며 본인 테스트 발송까지 완료됐다. 최신 `.ait` 428,653바이트의 비밀값 검사도 다시 통과했다. 검수 요청·출시는 수행하지 않았다. 운영용 HTTPS API 주소가 없는 빌드이므로 이 테스트 발송으로는 앱 진입과 안전한 연결 불가 상태만 확인할 수 있고, 실제 토스 식별과 전체 리딩 흐름 검증은 HTTPS API와 mTLS 연결 후 진행해야 한다. 콘솔 등록 아이콘도 아직 비어 있어 실기기 진입 시 별도 오류가 발생하는지 확인이 필요하다.

본인 토스 앱에서 위 테스트 번들의 진입을 확인했다. 토스 네이티브 상단 헤더와 `tarororo` WebView는 정상적으로 열렸고, 화면은 의도한 `지금은 서비스를 열 수 없어요` 연결 차단 상태를 표시했다. 이는 기기·아이콘 로딩 실패가 아니라 빌드 시 `VITE_API_BASE_URL`이 없어서 `ai-tarot/src/api/service.ts`가 운영 모드의 API 호출을 시작하지 않은 결과다. 현재 서버 환경도 `APP_ENV=local`, `AUTH_MODE=mock`이고 `TOSS_MTLS_CERT_PATH`와 `TOSS_MTLS_KEY_PATH`가 없음을 값 노출 없이 확인했다. 콘솔의 `tarotaro` 워크스페이스는 `verified=false`, `reviewState=DRAFT`, `licenseType=PERSONAL` 상태다. 따라서 다음 실기기 기능 검증 전제는 공개 HTTPS 서버·운영 DB, 워크스페이스/인증서 준비, 서버의 Toss 인증 모드, 그리고 그 서버 주소를 넣은 새 프런트 번들이다.

최종 코드 검토에서 인증 실패 시 복구 키 보존과 AI 형식 오류 재시도 문제를 수정했고, 후속 검토에서 두 문제가 해결됐으며 새 주요 결함이 없음을 확인했다. 화면 pagination은 후속 변경에서 연결했으며, 번들 크기는 실제 기기 성능 확인이 필요한 과제로 남긴다.

상세 실행 증거와 검토 보고서는 작업공간의 `.superpowers/sdd/2026-09-11-reading-flow/`에 보관한다. 위 Reading ID는 격리된 시험 실행의 증거이며, 검증용 API·worker·Vite 프로세스와 해당 임시 DB 스키마는 정리했다. 기존 로컬 PostgreSQL은 실행 상태로 유지했고 마지막 데이터 비교에서도 원래 57개 레코드가 보존됐다. 실제 키와 세션 토큰은 보고서에 넣지 않았다. 기반 구현은 `main`에 병합됐으며 콘솔 검수 요청·출시는 수행하지 않았다.
