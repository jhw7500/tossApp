# 오프라인 콘텐츠 반영 설계와 테스트 계획

상태: **관리자 계약 검토용 초안, 구현 전**. 근거 HEAD는 `4b2cd59951e7c3144c4f8871f437dc9390dc610f`다. 이 문서는 합성 CSV와 합성 catalog/기존 버전 snapshot으로 반영 계획을 계산하는 설계를 제안한다. 실제 DB 조회, 임시 DB 생성, importer 구현, SQL 적용, import, 활성화는 수행하지 않았다.

아래에서 **현재 계약**은 저장소에서 확인한 사실이고, **제안**은 관리자가 승인해야 하는 후속 계약이다. 코드 블록의 타입·함수·오류명은 모두 의사코드다. 아직 사용할 수 있는 API나 CLI가 아니다. 실제 타로 원문·사용 권리·사람 타로리더의 판정을 새로 작성하거나 추정하지 않는다. 합성 fixture의 성공은 `MECHANICS_ONLY`이며 제품 콘텐츠 승인이 아니다.

## 1. 현재 dry-run과 DB 반영 사이의 gap

| 영역 | 현재 소스와 보장 | 아직 없는 반영 계약 |
| --- | --- | --- |
| CSV 입구 | [validate-content.mjs](../../scripts/content/validate-content.mjs) `validateFile`, 17행: 파일을 읽고 fatal UTF-8 decode 후 검증·출력한다. 입력·DB를 쓰지 않는다. | snapshot 입력, 반영 계획 출력, executor가 없다. 문자열 검증 함수 자체는 UTF-8 바이트 오류를 검사하지 않는다. |
| 파싱과 정규화 | [csv.mjs](../../scripts/content/csv.mjs) `parseCsv`, [validate.mjs](../../scripts/content/validate.mjs) `validateRow`, 60행: 인용 필드의 LF/CRLF와 본문·출처를 보존하고 UUID는 소문자, locale은 `Intl.Locale` 정규형으로 만든다. | `validateContentCsv`의 반환값은 `errors`, `warnings`, `summary`뿐이다. 내부 `typedRows`는 공개되지 않는다. planner가 같은 규칙을 다시 구현하면 안 된다. |
| 파일 내부 제약 | [validate.mjs](../../scripts/content/validate.mjs) `validateGroups`, 112행: 동일 UUID의 카드·locale 일치, `(interpretation_id, version)` 중복, 원문별 정확히 한 활성 버전을 검사한다. | CSV에 없는 DB 이력, UUID 충돌, 카드 존재, 기존 상태 변경은 알 수 없다. 첫 버전 1과 증가 정책은 [작성 안내](README.md)에 있지만 검증기는 정수 범위만 검사한다. |
| 카드와 논리 원문 | [001_foundation.sql](../../server/migrations/001_foundation.sql) 60행: `tarot_cards.code`는 unique, `interpretations.tarot_card_id`는 FK다. [002_interpretation_candidates.sql](../../server/migrations/002_interpretation_candidates.sql)은 카드·locale unique를 제거한다. | `card_code -> tarot_cards.id` 매핑이 필요하다. 한 카드·locale에 서로 다른 원문 UUID가 여러 개 있는 것은 정상이다. |
| 버전과 활성화 | [001_foundation.sql](../../server/migrations/001_foundation.sql) 78행: 버전 자체 UUID PK와 `(interpretation_id, version)` unique가 모두 필요하다. [003_reading_flow.sql](../../server/migrations/003_reading_flow.sql) 4행: `is_active` 기본값은 true, `active_version`은 nullable integer이며 복합 FK는 deferred다. | CSV의 UUID는 `interpretations.id`다. `interpretation_versions.id`는 CSV에 없고, CSV의 활성 표시는 DB 컬럼이 아니다. 신규 UUID 할당·비활성 저장·활성 전환을 따로 정의해야 한다. |
| 이력 보존 | [003_reading_flow.sql](../../server/migrations/003_reading_flow.sql) 42행: 달라지는 버전 UPDATE를 trigger가 거부한다. 82행: `reading_evidence`는 `(interpretation_id, version)`을 참조한다. | trigger는 DELETE 전면 금지가 아니다. importer가 본문 UPDATE·DELETE·부모 삭제를 계획하지 않는 별도 정책이 필요하다. |
| 런타임 소비 | [snapshot.ts](../../server/src/readings/snapshot.ts) `buildReadingSnapshot`, 31행: 한 SQL의 MVCC view에서 selectable 카드와 `i.is_active`, 정확한 `i.locale = 'ko-KR'`, 활성 버전의 비공백 본문을 읽는다. 후보당 키는 `interpretationId`, `version`, `text`, `sourceKind`, `sourceAttribution`이다. | 입력 CSV만의 후보 수로는 DB와 합쳐진 상태를 보장할 수 없다. production은 후보에 `synthetic_test`가 하나라도 있으면 거부한다. |
| context와 과거 리딩 | [snapshot.ts](../../server/src/readings/snapshot.ts) 6·65행, [reading.schemas.ts](../../contracts/reading.schemas.ts) 43·79행, [store.ts](../../server/src/readings/store.ts) `persistSnapshot`, [context.ts](../../server/src/ai/context.ts): 전체 context를 만들고 저장된 snapshot을 AI 입력으로 사용한다. | 활성 전환 후에도 과거 `request_snapshot`·evidence·재시도 입력은 그대로여야 한다. 버전 UUID는 현재 후보/evidence의 식별 필드가 아니다. |
| 개발 seed | [seed.ts](../../server/src/db/seed.ts) 28행: `the-fool`, `the-lovers`, `the-star` 세 카드와 합성 이력을 넣는다. | 이것은 전체 78장 목록이나 운영 catalog의 근거가 아니다. seed의 고정 UUID 생성 방식과 `ON CONFLICT DO NOTHING`을 importer 정책으로 복사하지 않는다. |

## 2. 접근 방식과 추천 경계

| 방식 | 장점 | 제약과 판단 |
| --- | --- | --- |
| CSV를 바로 SQL/import로 연결 | 구현 경로가 짧다. | DB 상태와 검증이 섞여 오프라인 재현·사전 검토가 어렵다. 이번 범위와 맞지 않는다. |
| **순수 planner + 별도 executor** | 같은 입력으로 같은 계획을 재현하고 충돌·활성 전환을 DB 없이 검토할 수 있다. | snapshot 완전성, UUID 할당 입력, 적용 직전 상태 재검증을 계약으로 정해야 한다. **추천 제안**이다. |
| 전체 catalog/원문 동기화 서비스 | 장기적인 대규모 동기화에 대응할 수 있다. | 삭제·대체·스키마·서비스 운영까지 범위가 넓어진다. 첫 구현 단위에서는 제외한다. |

```text
Synthetic CSV bytes ----> existing validation core ----> validated rows
                                                           |
Synthetic catalog + all stored versions -------------------+
Explicit version-ID allocations + mode --------------------+
                                                           v
                                                  pure offline planner
                                                           |
                                         diagnostics + immutable plan
                                                           |
                                         manager contract review [STOP]

Future, separately authorized:
approved plan + target + backup -> DB executor -> one transaction
```

planner는 파일·환경변수·시계·난수·DB·네트워크를 직접 읽지 않는다. 모든 값은 인자로 받고 입력 객체를 변경하지 않는다. 파일을 읽고 보고서를 저장하는 wrapper도 planner와 분리한다. 첫 후속 구현은 합성 데이터만 사용하는 planner까지이며 executor나 실제 snapshot 추출기를 함께 넣지 않는다.

### 2.1 기존 검증기 재사용 제안

후속 계약 리뷰에서 [validate.mjs](../../scripts/content/validate.mjs)의 내부 검증 결과를 공유하는 작은 공개 인터페이스를 승인한다. 예를 들어 `validateContentDocument(source)`가 성공 시 정규화된 행을 추가 반환하고, 기존 `validateContentCsv(source)`는 동일한 내부 결과에서 기존 세 필드만 반환하도록 유지한다. 오류가 있으면 planner에 사용할 행을 반환하지 않는다. 기존 CLI 메시지·종료 코드·30개 테스트의 관찰 결과를 유지하는 것이 조건이다.

`parseCsv`를 따로 호출하여 UUID/locale/boolean/본문 규칙을 planner에서 재작성하지 않는다. 용량 계산 역시 현재 내부 `buildCardSummary`를 공유 가능한 순수 요약 함수로 분리하는 최소 변경을 제안한다. 확장은 검증기의 후속 담당 범위 승인이 필요하며 이 세션에서는 파일을 수정하지 않는다. UTF-8 decode는 현재 CLI와 같은 fatal 정책을 wrapper 입구에서 사용한다.

입력 wrapper는 decode 전 원본 `csvBytes`의 SHA-256을 계산하고, 검증 성공 시에만 `ValidatedContentDocument { rows, rawCsvHash, validatorRevision }`를 구성해 planner에 전달하는 것을 제안한다(D1). `validatorRevision`은 호출자가 명시적으로 제공한다. planner는 이 문서의 `rows`로 계획을 계산하고 `rawCsvHash`를 결과의 `evidence.csvHash`로 전달한다. 정규화된 행을 재직렬화해서 원본 바이트 hash를 복원하려 하지 않는다. 이 전달 타입과 함수명은 아직 구현된 공개 API가 아니다.

## 3. 오프라인 입력과 출력 계약 제안

### 3.1 입력

| 입력 | 필수 필드/의미 | 검증과 경계 |
| --- | --- | --- |
| `csvBytes` | 기존 [8열 템플릿](../../content/interpretations.template.csv)의 원본 바이트. 최초 시험에는 [기존 합성 fixture](../../content/fixtures/synthetic-test.csv)를 사용한다. | 원본 SHA-256을 기록하고 엄격히 decode한다. BOM/CSV 인용부호는 파서가 처리하되 본문·출처의 공백·줄바꿈·Unicode를 임의 정규화하지 않는다. |
| `validatedDocument` | 입력 wrapper가 성공 시 구성하는 `rows`, `rawCsvHash`, `validatorRevision`. | planner에는 `csvBytes` 대신 이 값을 전달한다. raw hash 계산과 fatal decode는 wrapper 책임이며, 오류가 있는 문서에서 부분 행을 전달하지 않는다. |
| `snapshot.header` | 제안 형식 버전, 합성 dataset ID, `contentSchemaProfile`, `coverage = full-content`, snapshot 식별자. | 모든 catalog·원문·버전 행을 담은 한 논리 시점이라는 입력 계약이다. scope 누락·불명 형식은 중단한다. 실제 추출 시점과 완전성은 추후 승인된 추출자가 보증해야 하며 선언만으로 DB 사실을 증명하지 않는다. |
| `snapshot.cards[]` | `id`, `code`, `name`, `arcana`, `imageUrl`, `isSelectable`. | 전체 카드 PK와 code의 유일성을 확인한다. code는 검증된 문자열 그대로 정확히 매칭하고 trim/소문자화/별칭 추론을 하지 않는다. 새 카드를 자동 생성하지 않는다. |
| `snapshot.interpretations[]` | `id`, `tarotCardId`, `locale`, `activeVersion: integer or null`, `isActive`. | 전체 원문을 모든 locale·활성/비활성 상태로 포함한다. CSV에 없는 원문도 충돌/후보 합산에 필요하다. 카드 FK와 원문 PK를 확인한다. |
| `snapshot.versions[]` | `id`, `interpretationId`, `version`, `content`, `sourceKind`, `sourceAttribution`. | 전체 버전 PK·복합키 및 부모 FK를 확인한다. 최대 버전, 기존 본문 동일성, 전체 버전 UUID 충돌을 판단하려면 이력이 빠지면 안 된다. 생성 시각은 INSERT 메타데이터이지 CSV payload 비교 대상이 아니다. |
| `versionIdAllocations[]` | 새 `(interpretationId, version)`에 배정할 별도 `versionId`. | 난수 생성은 planner 바깥 책임이다. 오프라인 테스트에는 고정 합성 UUID를 주입한다. 기존 pair는 snapshot의 ID를 재사용한다. 재실행 manifest에 할당값이 있으면 기존 ID와 같은지 확인한다. |
| `options` | 제안 정책 버전, `mode = stage or activate`, `targetClass = synthetic-test or production`, 명시적 locale 허용 목록. | 생략된 mode는 `stage`를 제안한다. 첫 구현에서는 `synthetic-test`만 지원하고 실제 환경 이름·접속정보·비밀값은 받지 않는다. `activate`도 계획을 만들 뿐 실행 승인이 아니다. |

최소 구현에서는 부분 snapshot을 허용하지 않는 것을 제안한다. 특정 카드만 export하면 파일 밖 UUID 충돌이나 가장 큰 세 카드의 후보 합계를 놓칠 수 있다. 부분 snapshot/조회 증명이 필요해지면 별도 계약으로 검토한다. 실제 사용자·Person·리딩 데이터는 이 snapshot에 필요하지 않다.

snapshot의 UUID는 PostgreSQL 값과 같은 소문자 표현으로 비교한다. 기존 locale이 유효하더라도 비정규형이면 변경 대상 또는 용량 계산에 영향을 주는 행을 `LEGACY_LOCALE_REVIEW`로 보고한다. `ko-kr`를 `ko-KR`처럼 이미 런타임에 노출되고 있다고 계산하거나 조용히 DB 교정하지 않는다. 손상된 FK·중복 PK·활성인데 버전이 null인 상태는 `SNAPSHOT_INVALID`로 중단한다. 비활성 원문의 null 포인터는 정상 staging 상태로 허용한다.

### 3.2 결과

```text
planContentImport(validatedDocument, snapshot, versionIdAllocations, options)
  -> {
       status: READY | BLOCKED,
       evidence: { csvHash, snapshotHash, policyVersion, validatorRevision },
       diagnostics: [{ code, phase, csvLine?, field?, entityKey, message }],
       preconditions: { catalogAndContentDigest, expectedBeforeStates },
       postconditions: { catalogAndContentDigest, expectedAfterStates },
       operations: {
         insertInterpretations, insertVersions, setInterpretationState
       },
       unchanged: [{ entityKey, reason }],
       capacity: { storedAfter, activationPreview, fullContext: NOT_PROVEN },
       summary: { newInterpretations, newVersions, stateChanges, noops },
       planDigest
     }
```

`READY`는 주어진 snapshot에 대해 계획이 일관됨을 뜻한다. DB 접속 가능, 운영 권한, 원문 사용 권리, 사람 품질 승인, 활성화 승인을 뜻하지 않는다. 하나라도 오류가 있으면 `BLOCKED`, 실행 가능한 `operations`는 비워 부분 적용을 방지한다. 경고와 오류를 구분하고 기존 CSV 진단의 행/열을 보존한다. 오류에는 본문 전체를 출력하지 않는다.

해시는 파일 원본과 정규화된 의미를 구분한다. snapshot/plan 직렬화의 키 순서와 배열 정렬을 정책으로 고정하고 UUID·정수 version 순서로 정렬한다. 진단의 CSV 행 위치는 원래대로 유지한다. 같은 입력이면 같은 계획/해시가 나와야 하며 임의의 생성 시각은 계획 해시에 넣지 않는다. snapshot 해시에는 모든 매핑, 버전 payload/ID, 활성 상태, 용량 관련 카드 메타데이터를 포함한다. 적용 전후 비교용 `catalogAndContentDigest`는 세 입력 테이블의 명시된 필드 전체를 대상으로 하되 snapshot 식별자/추출 시각·DB 생성 시각은 제외한다. before/after 양쪽 digest와 상태를 보존해 전체 재실행과 일부 적용을 구별한다. hash는 변경 탐지 수단이며 승인 서명이나 출처의 진위를 증명하지 않는다.

## 4. 매핑, 충돌, 이력 정책

아래의 처리 정책은 모두 **제안/관리자 결정 필요**다. DB가 이미 보장하는 제약은 별도로 적었다.

| 항목 | 현재 DB/CSV 사실 | planner 처리 제안 |
| --- | --- | --- |
| 카드 매핑 | CSV `card_code`, DB `tarot_cards.code -> id -> interpretations.tarot_card_id`. | 매칭 0건은 `UNKNOWN_CARD`, snapshot code 중복은 `SNAPSHOT_INVALID`. 미등록 카드 생성·추측 매핑은 하지 않는다. 비선택 카드는 stage 경고, activate 오류로 분리한다. |
| 논리 원문 ID | CSV `interpretation_id`는 `interpretations.id`다. UUID 대소문자는 검증기에서 정규화한다. | 기존 ID의 카드 또는 canonical locale이 다르면 `IDENTITY_CONFLICT`. CSV에 같은 ID의 서로 다른 버전이 있는 것은 정상 이력이다. |
| 버전 행 ID | `interpretation_versions.id`는 별도 UUID PK다. CSV에는 없다. 두 테이블 사이 UUID 값의 전역 유일성 제약은 없다. | 기존 pair는 저장된 version ID를 사용한다. 새 pair에는 명시적 할당 ID가 필요하다. 같은 version ID가 다른 pair/다른 새 행에 쓰이면 `VERSION_ID_CONFLICT`. 논리 ID와 version ID를 동일한 식별자로 취급하지 않는다. |
| 신규 원문 | DB는 version 1 이상만 강제한다. 작성 안내는 첫 버전 1이다. | snapshot에 ID가 없으면 신규. 첫 버전 1이 포함되어야 하며 한 배치에 여러 버전을 허용한다. 버전 간 빈 번호를 허용할지는 D3에서 결정한다. |
| 기존 원문 수정 | 같은 논리 ID 아래에 버전 행을 추가한다. | 존재하지 않는 version은 snapshot의 최대 version보다 커야 한다. 과거의 빈 번호를 채우는 backfill과 번호 자동 재할당은 거부한다. |
| 같은 pair 재입력 | DB unique는 `(interpretation_id, version)`이다. | 본문·출처 종류·출처 표기가 모두 정확히 같으면 INSERT no-op. 하나라도 다르면 `IMMUTABLE_PAYLOAD_CONFLICT`. LF/CRLF, trailing space 차이도 변경이다. CSV 활성 표시는 payload 비교에서 제외한다. |
| 버전 UUID 재할당 | 기존 pair의 ID는 이미 정해져 있다. | manifest가 다른 ID를 요구하면 `VERSION_ID_CONFLICT`. 실제 저장된 ID를 바꾸거나 충돌을 숨기지 않는다. CSV에 없는 pair의 할당/동일 pair 중복 할당도 입력 오류다. 재실행에서 기존 pair와 같은 ID의 할당을 보존하는 것은 허용한다. |
| 파일 내부 중복 | 검증기가 같은 pair 중복을 거부한다. | 두 행의 내용이 같아도 실패를 유지한다. DB에 같은 행이 이미 있어 no-op인 상황과 구분한다. |
| canonical locale | DB는 text, 런타임은 정확히 `ko-KR`. | 새 원문은 검증기가 반환한 canonical 값을 저장한다. `ko-kr -> ko-KR`, `ko`는 `ko-KR`로 추론하지 않는다. 다른 유효 locale은 stage 경고로 보존하되 현재 activate 계획은 거부한다. 기존 locale 교정은 별도 작업이다. |
| immutable 이력 | 버전 UPDATE 변경은 trigger로 차단되지만 삭제 전체를 막지는 않는다. | INSERT만 계획한다. 본문·출처 UPDATE, DELETE, cascade, 강제 overwrite는 제공하지 않는다. CSV에서 생략한 버전/원문은 그대로 둔다. |
| version 상한 | signed 32-bit, `1..2147483647`. | 최대값 다음 신규 버전은 중단한다. wrap, UUID 교체로 이력 단절, 자동 정리는 하지 않는다. |

### 4.1 활성 상태와 재실행

`is_active_version`은 같은 논리 원문 안에서 사용할 버전 번호를 선택한다. `interpretations.is_active`는 그 논리 원문 자체의 노출 여부다. `active_version`에는 **버전의 integer 번호**를 넣으며 `interpretation_versions.id` UUID를 넣지 않는다.

| mode와 대상 | `active_version` after | `is_active` after | 적용 의미 |
| --- | --- | --- | --- |
| stage, 새 원문 | null | false | 버전만 저장하고 노출하지 않는다. DB의 true 기본값에 의존하지 않고 명시한다. 활성 의도는 계획에 보존한다. |
| stage, 기존 원문 | before 유지 | before 유지 | 새 버전이 있어도 기존 활성 선택과 비활성을 유지한다. |
| activate, 명시된 원문 | CSV에서 true인 행의 version | true | 재활성화도 포함하는 명시적 상태 변경이다. before/after를 보고서에 표시하며 별도 운영 승인이 필요하다. |
| CSV에서 생략한 원문/버전 | before 유지 | before 유지 | 입력을 전체 대체 목록으로 해석하지 않는다. |

CSV의 모든 행을 false로 해서 원문을 비활성화하는 동작은 기존 검증 계약에 맞지 않는다. 비활성화/폐기는 후속 별도 계약으로 남긴다. 현재 활성 version보다 낮은 번호를 고르는 일반 activate 계획은 `ACTIVATION_REGRESSION`으로 거부하는 것을 제안한다. 이전 활성 상태로 돌아가는 운영 rollback은 별도로 검토한다. 과거 inactive 포인터가 높은 경우도 조용히 낮추지 않는다.

```text
                    before           after stage       after activate
new I1              absent           (null, false)     (2, true)
existing I2         (1, true)         (1, true)         (2, true)
history for I2      [V21]             [V21, V22]        [V21, V22]
saved reading R1    I2/version=1      I2/version=1      I2/version=1

state tuple = (active_version, is_active)
I1/I2/V21/V22/R1 are symbolic test identities, not literal UUID inputs.
```

재실행 계약은 두 경우를 구분한다.

1. **새 snapshot으로 다시 계획**: 이미 같은 버전 payload/ID와 요청 상태가 있으면 no-op이다. 같은 CSV라도 snapshot이 바뀌면 planDigest는 달라질 수 있다. 활성 포인터가 더 나중 버전으로 옮겨갔다면 과거 계획 재실행으로 되돌리지 않고 충돌로 중단한다.
2. **보존한 계획을 다시 실행**: executor는 같은 target과 planDigest에서 모든 기대 postcondition이 정확히 충족되면 `ALREADY_APPLIED`로 보고 쓰지 않는다. 모두 before와 같으면 적용 가능하다. 일부만 after이거나 관계없는 catalog/후보가 바뀌면 `STALE_PLAN`으로 중단하고 재계획한다. 본문만 같은 것으로 활성 상태까지 적용됐다고 판단하지 않는다.

DB의 [기존 idempotency_requests](../../server/migrations/003_reading_flow.sql)는 사용자 리딩/attempt를 참조하므로 import 기록으로 재사용하지 않는다. 최소 executor는 승인된 계획 파일과 명시적인 before/after 검사를 사용한다. 별도 DB import ledger가 필요하면 스키마 소유자의 후속 결정으로 남긴다.

## 5. 파일 검증, snapshot 대조, 런타임의 책임

| 책임 | 수행할 검사 | 증명하지 못하는 것 |
| --- | --- | --- |
| 기존 파일 validator | CSV/UTF-8 입구, 필수값, UUID/locale/version/boolean, source kind, 파일 내 카드·locale 불변/버전 중복/정확히 한 활성, 파일 후보 수와 후보 바이트. | 카드 존재, 기존 데이터 충돌, 권리, 실제 DB 상태. |
| snapshot 구조 검사 | 전체 coverage, PK/복합키/FK, locale 표현, active 포인터의 대상 존재, 할당 ID 충돌, 현재 상태의 일관성. | 입력이 실제 환경을 정확히 추출했다는 사실과 이후 변경 여부. |
| planner 대조 | 카드 매핑, 신규/동일/충돌 분류, append-only, before/after, 생략 데이터 보존, **기존 DB 후보와 합친** 용량. | 미래 동시 변경, 전체 질문 조합, 실제 적용 성공. |
| 미래 executor | 대상/계획 승인, 적용 직전 잠금·상태 재검사, 파라미터 쿼리·영향 행 수, FK, 원자성, commit 결과 확인. | 원문 저작권·타로 해석의 정확성. |
| 런타임/품질 평가 | 실제 전체 context 크기, 3장/각 1..20 후보, production 합성 거부, 저장된 snapshot 소비. | 합성 자료만으로 사람 타로리더의 콘텐츠 품질 승인. |

용량 계산은 CSV rows를 기존 활성 후보에 단순 추가하지 않는다. 먼저 version INSERT와 원문별 after 상태를 메모리에 반영한 뒤, 활성 원문에서 포인터가 선택한 비공백 본문의 한 버전만 후보로 만든다. ko-KR 소비 집합은 locale의 정확한 일치와 selectable 카드 조건까지 런타임에 맞춰 구한다. CSV에 없는 원문을 포함하고 교체된 같은 원문의 옛 버전은 이중 계산하지 않는다. 과거 비활성 이력에 CSV 작성 규칙을 소급 적용하거나 본문을 교정하지 않는다. stage의 저장 후 상태와 CSV 활성 의도를 적용한 preview를 구분해 보고한다.

현재 validator와 동일한 candidate JSON 형태 및 공유 요약 함수를 사용한다. 카드/locale당 **20개는 허용, 21개는 실패**다. 가장 큰 `ko-KR` 세 카드의 후보 배열 UTF-8 합계가 **65536 이상이면 실패**다. stage에서도 예정 활성 preview가 이 제한을 넘으면 해당 묶음을 차단하는 보수적 정책을 제안한다(D4). `capacity.storedAfter`와 `capacity.activationPreview`의 런타임 용량 집합은 selectable 카드만 포함한다. 비선택 카드까지 집계하는 보수적 요약이 필요하면 별도 `conservativeInventorySummary`로 표시하고 런타임 용량과 혼용하지 않는다. 이 추가 요약의 제공·차단 정책은 D4의 별도 결정이며 첫 구현의 필수 필드가 아니다. 카드가 3장 미만이면 있는 카드 합만 계산하므로 3장 리딩 가능 여부를 보장하지 않는다.

실제 런타임은 [snapshot.ts](../../server/src/readings/snapshot.ts)에서 `Buffer.byteLength(JSON.stringify(toReadingContext(snapshot)), 'utf8') > 65536`일 때 실패한다. 따라서 **후보만 65536이면 실패**, **전체 context가 정확히 65536이면 바이트 조건은 통과**라는 차이를 유지한다. 관계·상황·질문·카드 메타데이터·position·JSON 감싸기 비용은 후보 합계에 없다. 후보 65535 성공은 전체 context 성공이 아니다. 첫 planner 결과는 `fullContext = NOT_PROVEN`으로 표시한다. 모든 조합의 성공을 주장하려면 별도 합성 최대길이 context 시험과 질문/catalog 범위 계약이 필요하다. 원문 절삭·후보 누락으로 크기를 맞추지 않는다.

production에 넣을 자료는 `synthetic_test` 검출 시 중단해야 하며, `editorial`/`licensed` 표기 자체는 사용 권리를 입증하지 않는다. 실제 원문, 출처·권리 근거, 대상 카드 범위와 사람 검토자를 확보하는 절차는 기계 검증과 분리한다.

## 6. 미래 DB executor와 실패 경계 제안

이 절의 순서는 **미실행 설계**이며 SQL이나 실행 명령을 제공하는 운영 승인이 아니다.

```text
target/plan/backup approval
  -> BEGIN
  -> acquire bounded write-blocking locks
  -> reread catalog + content; verify before/after and capacity
  -> insert inactive parents -> append version rows
  -> update (active_version, is_active) together for activate mode
  -> verify affected rows, deferred FK, final state
  -> COMMIT
       failure before commit -> ROLLBACK whole batch
       lost commit response  -> outcome UNKNOWN; inspect before retry
```

최소 구현의 동시성 제안은 고정 순서로 `tarot_cards`, `interpretations`, `interpretation_versions`에 쓰기를 막되 일반 읽기는 허용하는 명시적 잠금을 잡고, 잠금 뒤 새 SQL statement로 전체 관련 상태를 읽는 것이다. 구체적인 PostgreSQL lock mode/권한·isolation·timeout은 executor 계약 리뷰에서 확정하고 별도 DB 시험으로 검증한다(D5). 이 방식은 다른 쓰기를 기다리게 하므로 실제 명령 승인 때 영향을 설명해야 한다. 기존 원문 행 잠금만으로는 새로운 원문 INSERT에 의한 후보 수 초과를 막지 못한다. advisory lock만 사용하려면 모든 작성자가 참여한다는 근거가 추가로 필요하다.

한 배치 전체를 한 transaction으로 처리하고 활성 원문의 두 컬럼을 함께 변경한다. 기존 reader는 콘텐츠를 단일 SELECT로 읽으므로 commit 전후 중 하나의 일관된 상태를 본다는 현재 소비 계약에 맞춘다. stage는 기존 활성 상태를 쓰지 않고 새 부모를 `(null, false)`로 저장한다. activate는 같은 transaction에서 신규 이력과 새 포인터를 함께 가시화한다. deferred FK를 commit 전에 확인하더라도 commit 자체 실패를 별도로 처리한다. 무조건적인 `ON CONFLICT DO NOTHING`으로 payload·ID 충돌을 숨기지 않는다.

commit 전 오류·영향 행 수 불일치·잠금 시간 초과는 전체 rollback으로 끝낸다. 연결이 끊겨 commit 결과가 불명확하면 성공이나 rollback 완료로 단정하지 않는다. 승인된 조회로 postcondition을 대조하기 전 재실행하지 않는다.

commit 후 되돌리기는 transaction rollback과 다르다. 보존한 before 상태로 활성 포인터/노출 상태만 복원하는 새 계획을 검토하고 별도 승인받는다. 추가한 버전은 지우지 않고, 이후 다른 운영자가 변경했다면 복원도 중단한다. 새 원문은 비활성화해 보존할 수 있다. 이미 생성된 reading snapshot/evidence는 수정하지 않는다. 백업 복원은 다른 데이터까지 영향을 주므로 기본 동작으로 제안하지 않는다.

## 7. 후속 최소 테스트 계획

아래는 **아직 구현·실행하지 않은 테스트**다. P는 DB/네트워크 없는 순수 planner 시험, E는 별도 승인 후 executor/DB 통합 시험, R은 후속 런타임 계약 시험이다. 실제 타로 의미 대신 기존 합성 fixture 또는 `synthetic_test`로 표시한 기계적 합성 문자열·고정 UUID만 사용한다.

| ID | 수준과 입력/사건 | 예상 결과 |
| --- | --- | --- |
| P01 | 기존 5행 fixture + 완전한 합성 3장 catalog + 빈 원문/버전 snapshot + 버전 ID 5개 | stage 계획: 논리 원문 INSERT 4개, 버전 INSERT 5개, 부모는 모두 null/false. 활성 preview는 원문 4개·후보 798 bytes. 실제 쓰기 0. |
| P02 | catalog에 없는 card_code, 또는 code 중복/같은 카드 PK 중복 | `UNKNOWN_CARD` 또는 `SNAPSHOT_INVALID`, operations 없음. seed의 세 카드로 자동 대체하지 않음. |
| P03 | CSV 내부 동일 UUID/version 두 행, UUID 대소문자만 다른 중복 | 기존 validator에서 중단. payload가 같아도 중복 허용 안 함. |
| P04 | 같은 UUID의 여러 version / 같은 카드·locale의 서로 다른 UUID | 정상 이력/복수 후보. 논리 원문별 true는 정확히 하나여야 함. |
| P05 | 기존 원문 UUID가 다른 카드 또는 다른 locale에 속함 | `IDENTITY_CONFLICT`; 부모 재배치·locale 변경 없음. |
| P06 | 새 버전 ID가 기존의 다른 pair ID와 충돌 / 새 두 pair가 같은 ID 사용 / 할당 누락 | `VERSION_ID_CONFLICT` 또는 할당 오류. 기존 pair와 명시된 다른 ID도 거부. |
| P07 | 기존 pair에 동일 본문·출처를 다시 입력, 활성 표시만 변경 | 버전 INSERT no-op. stage는 상태 유지, activate는 승인 대상으로 상태 차이만 계획. |
| P08 | 기존 pair 본문·source kind·attribution 중 하나 변경; LF/CRLF·끝 공백 차이 | `IMMUTABLE_PAYLOAD_CONFLICT`; trim·정규화로 동일시하거나 UPDATE하지 않음. |
| P09 | stage/activate의 기대 after snapshot으로 같은 입력을 재계획 | 모두 존재·상태 같으면 operations 0. 새 UUID 생성 없음. 과거 CSV가 이후 활성 version을 낮추면 충돌. |
| P10 | 신규가 version 2부터 시작 / 기존 max 3인데 없는 version 2 삽입 / max int 다음 추가 | 제안 증가 정책에 따라 중단. 빈 번호 허용 최종 정책은 D3로 고정한 뒤 경계값을 시험. |
| P11 | 원문 하나에 true 0개 또는 2개 / false 이력과 true 한 개 | 앞 두 경우 파일 검증 실패, 마지막은 정상. snapshot에서 두 원문이 각각 활성인 것은 정상. |
| P12 | `ko-kr`, `ko-KR`, `ko`, 유효한 다른 locale, 기존 DB의 비정규형 locale | 앞 둘은 새 저장값 `ko-KR`. `ko`는 보강하지 않음. 다른 locale은 stage 경고/activate 실패. legacy는 조용히 교정하지 않음. |
| P13 | CSV 단독 1후보는 통과하지만 기존 같은 카드 활성 20개가 있음 | 합산 21개로 중단. 같은 원문 새 버전 교체라면 중복 가산하지 않아 20개 유지. |
| P14 | 서로 다른 카드 4개 이상 및 다국어·한글/emoji/escape가 있는 후보 | 가장 큰 ko-KR 세 배열만 후보 하한 계산, UTF-8/JSON 크기 정확성 확인. 파일 밖 기존 후보도 포함. |
| P15 | 후보 합 65535 / 65536 / 65537 bytes, 후보 수 20 / 21 | 후보 바이트 검사: 첫째만 통과; 후보 수: 20만 통과. 전체 context 성공 표시는 하지 않음. |
| P16 | stage 신규, 기존 활성, 기존 비활성, CSV에서 생략된 이력/원문 | 신규는 null/false, 기존 상태와 생략 데이터 보존. activate preview와 저장 후 상태를 구분. |
| P17 | 부분 snapshot, 부모/활성 버전 누락, 중복 복합키, is_active=true+null | `SNAPSHOT_INVALID`; 불완전 입력으로 READY 만들지 않음. 정상 비활성 null은 허용. |
| P18 | synthetic_test를 production 대상으로 계획 / 비선택 카드 activate | 차단. stage 비선택 카드에는 경고. production 지원 전에도 합성 자료를 운영 승인으로 표시하지 않음. |
| P19 | 입력 객체 freeze 후 두 번 계산, 파일 hash 전후 비교, CSV 행 순서만 교체 | 입력 불변, 같은 입력 같은 계획. 순서만 달라지면 raw CSV hash/진단 위치는 달라도 의미상 쓰기 집합은 동일. |
| P20 | 기존 CLI 정상/오류/BOM/quoted newline/잘못된 UTF-8 및 새 행 노출 인터페이스 | 기존 30개 관찰 계약 보존. 실패한 문서의 부분 행으로 계획 생성 안 함. |
| E01 | 검토 이후 다른 작성자가 같은 원문·카드·version·후보 집합을 변경 | 적용 전 `STALE_PLAN`, 쓰기 0. 일부 before/일부 after도 자동 보충하지 않음. |
| E02 | 두 importer가 다른 신규 원문으로 같은 카드의 21번째 후보를 경쟁 | 잠금/재검증으로 둘 다 잘못 통과하지 않음. timeout은 bounded 실패·rollback. |
| E03 | 부모 INSERT 뒤, 버전 INSERT 도중, 활성 UPDATE 뒤, deferred FK/commit에서 실패 주입 | 배치 전체 rollback, 반쪽 활성·고아 버전 없음. 각 실패 지점을 독립 시험. |
| E04 | commit 응답 유실 뒤 같은 계획을 제출 | 먼저 결과 UNKNOWN. postcondition 전부 일치 시 쓰기 없는 ALREADY_APPLIED, before 일치면 재적용 가능, 혼합/변경이면 중단. |
| E05 | 성공한 activate 전후에 reader가 snapshot 생성 / 이전 리딩 재시도 | 각 reader는 전체 before 또는 전체 after. 기존 리딩의 snapshot/evidence/AI context는 변하지 않음. |
| E06 | commit 후 활성 상태 복원, 그 사이 후속 활성 전환 발생 | 별도 승인 계획만 사용. 후속 변경이 있으면 중단. 본문/버전 삭제 및 과거 리딩 수정 없음. |
| R01 | 실제 전체 context 65535 / 65536 / 65537 bytes, 후보 하한은 작음 | 바이트 조건은 앞 둘 통과, 마지막 `CONTENT_CONTEXT_LIMIT`. 질문·상황·메타데이터 포함. |
| R02 | 3장 중 후보 없음, 21개, production에 합성 하나 포함 | 현재 런타임 거부 계약 유지. planner 성공을 리딩 성공이나 사람 품질 PASS로 치환하지 않음. |

실패 주입과 rollback의 P 수준 모의 결과만으로 E 수준 원자성·FK·잠금이 검증됐다고 주장하지 않는다. 새 임시 DB를 포함한 E 시험은 이 세션의 범위 밖이다.

## 8. 계약 결정 질문과 후속 최소 구현 단위

| 결정 | 추천 제안 | 관리자가 확정할 사항 |
| --- | --- | --- |
| D1 검증기 접점 | 내부 정규화 행과 후보 요약을 공유하고 기존 CLI 반환/출력 유지 | 공개 함수명·반환 타입·담당 파일 소유권. `contracts/` 변경은 첫 단위에 불필요하다는 제안. |
| D2 snapshot/ID | full-content snapshot, 명시적 version UUID 할당, hash에 before 상태 포함 | 추후 실제 snapshot 공급 주체·완전성 증명, 할당 manifest 보존·검증 방식. |
| D3 버전 정책 | 신규는 1 포함, 추가는 기존 max보다 큼, 빈 번호는 허용, backfill/자동 overwrite는 금지 | 빈 번호 허용 여부, 과거 활성 선택은 일반 import에서 거부하고 별도 rollback으로 다룰지. |
| D4 노출/locale/용량 | stage 기본, 새 부모 null/false, 기존 상태 유지, activate는 ko-KR만; stage에도 예정 활성 용량 제한 적용 | staging의 보수적 제한, legacy locale 발견 시 중단 범위, 재활성화와 별도 비활성화 계약. |
| D5 원자성/재실행 | 배치 단위 transaction, 쓰기 차단 잠금+잠금 후 재검증, before/after 대조 | 허용 지연·구체 lock/isolation/timeout·권한과 전체 snapshot 비용. import ledger 추가 필요 여부는 별도 결정. |
| D6 품질/운영 | 합성은 mechanics-only, 실제 권리·사람 판정·명령 승인은 별도 | 실제 원문/권리 제공자, 콘텐츠 검토자, 대상 환경, 실행 책임자와 활성 시점. |

후속 순서는 다음처럼 작은 계약 단위로 나누는 것을 제안한다.

1. **검증기 인터페이스 공유**: 승인된 소유 범위에서 정규화 행/후보 요약의 공개 접점만 추가하고 기존 회귀 검사와 새 결과 노출 검사를 한다. importer/runtime/schema/migration을 함께 고치지 않는다.
2. **합성 입력의 순수 planner**: 새 snapshot 타입·ID 할당 입력·상태 연산·진단·해시와 P01~P20을 구현한다. DB 라이브러리/접속정보/SQL 실행 없이 계약을 리뷰한다. snapshot을 만드는 실제 DB 추출기는 포함하지 않는다.
3. **executor 설계·시험**: 관리자가 소유를 배정한 뒤 별도 승인된 임시 환경에서 E/R 시험을 준비한다. 잠금·재실행·backup/rollback·권한 설계와 실행 결과를 리뷰한다. 운영 반영은 이 단계의 테스트 승인과 구분한다.
4. **실제 데이터 적용**: 아래 항목이 구체화된 후 사용자에게 실행 명령·대상·예상 영향·정지/복구 방법을 제시하고 별도 승인을 받는다. 승인 전에는 실제 DB snapshot 조회도 시작하지 않는다.

| 실제 실행 전 항목 | 준비할 검토 자료 | 필요한 승인/책임 |
| --- | --- | --- |
| 대상환경과 snapshot 조회 | 정확한 환경/DB 식별, catalog 범위, 조회 명령, snapshot 완전성·일관성 및 보관 위치. 비밀값은 보고서에 넣지 않는다. | 실제 DB 조회에 대한 사용자 승인과 운영 담당 소유권. |
| 실제 원문·권리·품질 | 원본 CSV hash, 출처/사용권 증거, 카드·locale 범위, 사람이 실제 내린 검토 결과. | 콘텐츠 책임자 검토. 합성 PASS로 대체 불가. |
| backup | 승인된 백업 도구·범위·저장 위치·복원 가능성·검증 증거와 보관 책임. | 백업 실행/복원 연습이 필요한 환경과 명령 각각의 승인. 기존 backup/timer 보존. |
| rollback | commit 전 실패 처리, commit 결과 불명 처리, commit 후 상태 복원 계획과 기대 before 조건. | 별도 복원 실행 승인. DELETE/강제 overwrite는 기본 경로에 없음. |
| 권한/동시성 | 허용 테이블의 조회·INSERT·상태 UPDATE·잠금 권한, timeout, 다른 writer에 미치는 영향. | 관리자 계정/DDL 권한을 기본 요구하지 않음. 구체 실행권한과 작업 시간대 승인. |
| import와 활성화 | 승인된 planDigest, 대상·mode·행 수·상태 diff, 구체 실행 명령·잠금 영향·실패 정지 조건. | import와 활성화 범위를 명시한 사용자 승인. stage 승인만으로 activate 불가. |
| 별도 운영 | 필요한 경우에만 migration, 서비스 재시작, 배포, 키 변경의 구체 제안. | 코드/문서/CI 승인을 운영 승인으로 간주하지 않고 별도로 승인받음. |

## 9. 이번 세션에서 실제 수행한 검증

2026-09-12, 위 근거 HEAD와 Node `v24.12.0`에서 기존 콘텐츠 baseline을 다시 실행했다. 이 결과는 신규 planner가 아닌 **기존 도구**에 대한 것이다.

| 실행/확인 | 실제 결과 |
| --- | --- |
| `rtk proxy env PATH=/home/jhw/.nvm/versions/node/v24.12.0/bin:$PATH TMPDIR="$PWD/.omx" node --test scripts/content/*.test.mjs` | 30 passed, 0 failed. 임시 CSV는 테스트 후 제거됨. DB/네트워크 없음. |
| `rtk proxy env PATH=/home/jhw/.nvm/versions/node/v24.12.0/bin:$PATH TMPDIR="$PWD/.omx" node scripts/content/validate-content.mjs content/fixtures/synthetic-test.csv` | exit 0; 5행, 카드 3개, 원문/활성 4개, 후보 798 bytes, 후보 기준 잔여 64738 bytes. |
| content CSV와 scripts/content 모듈의 실행 전후 SHA-256 | 모두 일치. 기존 fixture/검증기 변경 없음. |
| 신규 P/E/R 시험, DB 조회/생성, SQL 적용, import/활성화 | 미구현·미실행. 이 문서의 예상 결과를 실행 증거로 사용하지 않음. |

작성 세션은 raw 로그와 hash 기록을 그 세션의 비추적 로컬 `.omx/import-design-content-unit.log`, `.omx/import-design-synthetic-dry-run.log`, `.omx/import-design-baseline.json`에 남겼다. 이 파일들은 Git 산출물이 아니므로 다른 checkout에 존재하거나 장기 보존된다고 가정하지 않는다. 위 명령이 기존 도구 검증의 재현 경로이며, 최종 소스 대조·상대 링크·변경 범위·공백 검사 결과는 작성 세션의 인계 보고서에 기록했다.

**정지점:** 이 초안과 미커밋 diff를 인계한 뒤 관리자 계약 검토를 기다린다. 이 세션에서 구현으로 전환하거나 커밋·푸시·PR·실제 DB 작업을 시작하지 않는다.
