# AI 타로 개발 환경

앱인토스 AI 타로 서비스를 위한 WebView 실행 기반이다. `create-ait-app@0.2.7`의 React 18·TypeScript·TDS 템플릿으로 생성했다.

현재 프런트엔드는 형제 디렉터리의 [서버](../server/README.md)에 연결되어 Person 등록·수정·목록, 질문·카드 선택, Reading 생성·상태 조회·결과·기록·명시적 재시도 흐름을 제공한다. 화면은 디자인 전 기능 검증용이며 최종 브랜드와 카드 연출은 아직 적용하지 않았다. 개발 범위·우선순위·완료 기준은 사용자 지시와 [사양서](../docs/spec.pdf), [요청 메일](../docs/req.txt)을 따른다.

[handoff](../docs/ai-tarot-cli-handoff.md)는 사양서 없이 작성한 간이 검토 자료이므로 참고용으로만 활용한다. 문서에 제시된 MVP 범위·기술 선택·승인 절차는 확정 요구사항이 아니다.

## 로컬 실행

폰과 PC에서 API·실제 Gemini까지 함께 테스트하려면 상위 worktree 루트에서 `npm run dev`를 실행한다. [접속 주소와 실행 방법](../README.md)을 참조한다. 아래 명령은 프런트엔드만 실행한다.

저장소의 `ai-tarot/` 디렉터리에서 실행한다. Node 24 이상이 필요하며 `.nvmrc`에는 검증한 버전을 기록했다.

```bash
nvm use
npm ci
npm run dev
```

Vite가 출력하는 로컬 주소에서 화면을 확인한다. 브라우저용 SDK mock과 AIT 개발자 도구가 연결되어 있어 콘솔 로그인 없이 실행할 수 있다. AIT 패널의 Viewport에서 모바일 크기를 선택할 수 있다.

`vite.config.ts`는 SDK와 WebView bridge를 의존성 사전 번들에서 제외한다. 이 설정이 없으면 TDS 내부에서 실제 SDK를 불러와 브라우저에서 `safeAreaInsets` 오류가 발생한다.

로컬 개발에서는 기본적으로 `/api` 요청을 `http://127.0.0.1:3100`으로 프록시한다. 일반 브라우저에서만 익명 식별 mock을 쓰려면 `.env.example`처럼 `VITE_LOCAL_MOCK_AUTH=true`를 명시한다. 이 값은 개발 빌드에서만 유효하고 브라우저별 UUID를 `localStorage`에 유지한다. 실제 Toss 모드에서는 SDK `User.getAnonymousKey()`의 `HASH.hash`를 사용하며 SDK 오류를 mock 사용자로 대체하지 않는다.

운영 빌드는 `VITE_API_BASE_URL`에 명시적인 HTTPS 주소가 없으면 API 호출을 시작하지 않고 설정 오류 화면을 표시한다. 세션 token은 메모리에만 두며, 생성·재시도 접수 전의 idempotency envelope만 `sessionStorage`에 잠시 보존한다. 네트워크 결과가 불확실하면 새로고침 뒤 같은 key와 body로 확인하고, 서버가 접수했거나 Reading endpoint가 명확히 거절한 뒤 제거한다. 세션 식별 실패나 인증 갱신 실패는 접수 여부를 확정하지 않으므로 envelope를 유지한다.

본문은 시스템 서체를 사용하고, 데이터나 사용자 입력에 섞인 이모지만 Tossface의 `unicode-range` 웹폰트로 렌더하도록 공식 CDN CSS를 앞에 둔다. CDN 도달성은 실제 Toss 앱에서 별도로 확인해야 한다.

## 검증과 빌드

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run preview
```

`build`는 타입 검사 후 `dist/`와 `tarororo.ait`를 생성한다. `preview`는 생성된 웹 번들을 로컬에서 제공한다. 빌드는 업로드·출시를 수행하지 않는다.

배포용 번들에는 개발자 도구와 mock이 포함되지 않는다. 일반 브라우저의 `preview`에는 토스 호스트가 제공하는 값이 없어 화면 여백 조회 오류가 출력될 수 있다. 일반 브라우저에서 기능을 개발할 때는 `dev`를 사용하고, 실제 호스트 동작은 토스 앱에서 별도로 확인한다.

공식 TDS 템플릿과 현재 단일 화면 흐름은 초기 JavaScript 번들이 커서 Vite의 500 kB 청크 경고가 발생한다. 실제 서비스 디자인 단계에서 화면 단위 분할과 로딩 성능을 검토한다.

## 콘솔·실기기 단계

`apps-in-toss.config.ts`의 앱 식별자는 콘솔에 등록된 `tarororo`다. 콘솔 워크스페이스 `tarotaro`(ID `93125`)의 미니앱 `tarororo`(ID `75257`)로 등록되어 있으며 아직 출시되지 않았다. 현재 `permissions`는 빈 배열이다.

콘솔 인증, 번들 업로드, 토스 앱 실기기 검증, 심사와 출시는 각각 별도 단계다. `npm run deploy`는 실제 콘솔 업로드 명령이므로 로컬 검증에 사용하지 않는다.

공통 UI 기준은 [디자인 가이드](docs/design-guide.md)를 참조한다. 생성 시 TDS용 가이드와 `AGENTS.md`·`CLAUDE.md`를 포함했으며, 별도 CSS 토큰·아이콘·Tossface 서체는 주입하지 않았다.
