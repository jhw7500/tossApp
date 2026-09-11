# AI 타로 개발 환경

- 기능 범위·우선순위·완료 기준은 사용자 지시와 `../docs/spec.pdf`, 요청 메일 `../docs/req.txt`를 따른다.
- `../docs/ai-tarot-cli-handoff.md`는 사양서 없이 작성한 간이 검토 자료다. 도구 아이디어 등을 참고하는 용도로만 사용하며, 그 안의 MVP 범위·기술 선택·승인 절차를 확정 요구사항으로 적용하지 않는다.
- 현재 단계는 공식 TDS 템플릿 위의 리딩 기능 검증이다. 형제 `server/`의 PostgreSQL API에 연결해 Person 생성·수정·목록, DB 질문·카드 선택, Reading 생성·조회·재시도·기록 재방문을 검증한다. 최종 브랜드·카드 연출·실제 타로 콘텐츠 검수는 아직 범위 밖이다.
- Node 24 이상이 필요하다. 이 디렉터리에서 `nvm use`로 `.nvmrc`의 버전을 선택한다.
- 패키지 매니저는 npm이며 `package-lock.json`을 함께 관리한다.
- 개발 서버: `npm run dev`. 타입 검사: `npm run typecheck`. 정적 검사: `npm run lint`.
- PC/폰 실시간 통합 개발: 상위 worktree 루트에서 `npm run dev`. Vite·API·Gemini worker를 함께 실행한다. 접속/종료 방법은 `../README.md`를 따른다. `dev/lan-crypto.js`는 HTTP 사설망의 브라우저와 SDK mock에만 필요한 보완이며 배포 빌드에 포함하지 않는다.
- 전체 빌드: `npm run build` (타입 검사, Vite 빌드, `.ait` 생성). 빌드 결과 확인: `npm run preview`.
- 행동 테스트: `npm test`. 로컬 API는 기본 `/api` 프록시를 사용하고, 브라우저 mock 식별은 `VITE_LOCAL_MOCK_AUTH=true`를 명시한 개발 모드에만 허용한다. 운영은 명시적인 HTTPS `VITE_API_BASE_URL`이 필요하다.
- 앱 식별자는 콘솔에 등록된 `tarororo`다. 워크스페이스 `tarotaro`(ID `93125`)의 미니앱 `tarororo`(ID `75257`)로 등록되어 있으며 아직 출시되지 않았다.
- 빌드와 콘솔 업로드는 별개다. `npm run deploy`는 로컬 검증 명령이 아니다.

<!-- ait:design-guide v1 -->
앱인토스 미니앱 프로젝트다. 하드 규칙 위반은 `/ait:design`이 자동으로 고친다.

하드 규칙:
- 텍스트 11px 이하 금지, 본문은 15px 이상
- 모든 이모지는 Tossface로 렌더(폰트 스택 배선 또는 `.tf`)
- 한글은 `word-break: keep-all`
- 터치 타깃 44px 이상
- 하단 CTA는 safe area 34px
- 광고가 첫 화면 콘텐츠(ATF)를 가리지 않음
- 다크패턴(가짜 버튼·막다른 화면) 금지
- 꺾쇠·화살표는 텍스트 글리프 대신 SVG(currentColor)
- 상단 네비는 직접 그리지 않음(플랫폼 자동 배치)
- font-weight는 400~700만 사용

토큰 사용:
- 텍스트 색: `--color-text-strong/default/subtle/hint/disabled/inverse`
- 배경 색: `--color-bg`, `--color-bg-canvas`
- 상태 색: `--color-danger`/`--color-success`/`--color-warning`
- 브랜드 색: `--brand-primary`(중립 기본값, 바꿔도 됨)
- 타이포: `--font-size-*`/`--font-weight-*` 6단계(display~caption)
- 간격: `--space-1`~`--space-6`(4/8/12/16/24/32px)
- 오버레이: `--dim`(#000 대신)
- 인라인 style 객체에서도 `var()`가 그대로 동작한다

이 프로젝트는 TDS 기반이다 — 색·크기·아이콘은 TDS 컴포넌트가 주는 것을 쓴다(위 토큰 목록과 아이콘 파일 경로는 이 프로젝트에 없다).
1층 하드 규칙은 플랫폼 제약이라 그대로 적용된다 — 꺾쇠·닫기·검색은 TDS 아이콘 컴포넌트로 충족하고, 텍스트 글리프로 대체하는 것은 여전히 금지다.

전문(3층 전체 규칙): `docs/design-guide.md`.
판단이 애매하면 화면을 그리기 전에 먼저 읽는다.

다음 단계:
`/ait:design`   말로: "화면이 좀 구려 보여. 예쁘게 고쳐줘."
`/ait:design`   말로: "등록용 로고랑 스크린샷 만들어줘"
<!-- /ait:design-guide -->
