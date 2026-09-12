# 타로 원문 입력·검증 도구 설계

작성일: 2026-09-12

## 목적

타로리더가 카드별 복수 해석 원문을 스프레드시트에서 작성하고, 개발자가 DB에 반영하기 전에 형식·식별자·버전·출처·런타임 제한 위반을 로컬에서 확인할 수 있게 한다. 이 도구는 입력 파일을 읽고 결과만 출력하며 DB, migration, seed, 서버 설정을 변경하지 않는다.

실제 타로 의미는 타로리더가 작성한다. 저장소에 포함하는 예제 문장은 동작 검증용 `synthetic_test`로 명확히 표시하며 콘텐츠 품질의 근거로 사용하지 않는다.

## 범위

이 작업은 다음 경로만 소유한다.

- `content/`: CSV 입력 템플릿과 합성 테스트 fixture
- `scripts/content/`: CSV 파서, 검증 로직, dry-run CLI, 자동 테스트
- `docs/content/`: 작성자·개발자용 사용 안내

다음 항목은 다루지 않는다.

- 실제 타로리더 원문 또는 78장 전체 콘텐츠 생성
- DB import와 활성화
- `server/`의 migration, seed, 런타임 제한, AI prompt 변경
- 태그·카테고리, 정방향·역방향, 원문 선별 정책 확정

## 입력 계약

입력은 UTF-8 CSV 한 파일이다. 엑셀 또는 구글시트에서 편집·내보내기할 수 있도록 선택적인 UTF-8 BOM과 RFC 4180 방식의 인용부호, 쉼표, CRLF/LF, 인용된 필드 안의 줄바꿈을 지원한다. 첫 행은 아래의 정확한 헤더 순서를 사용한다.

| 열 | 계약 |
| --- | --- |
| `card_code` | 비어 있지 않고 제어 문자가 없는 카드 식별 코드. 같은 `interpretation_id`의 모든 버전에서 동일해야 한다. |
| `interpretation_id` | DB의 `interpretations.id`로 사용할 UUID. 한 원문의 버전들이 같은 값을 공유한다. |
| `locale` | `Intl.Locale`로 해석 가능한 locale. 정규형으로 그룹과 용량을 계산하며 현재 런타임에서 사용되는 `ko-KR` 외 locale은 경고한다. |
| `version` | PostgreSQL `integer`와 같은 1~2147483647 범위의 정수. 기존 버전은 수정하지 않고 새 행과 증가한 version으로 추가한다. |
| `is_active_version` | `true` 또는 `false`. 각 `interpretation_id`에서 정확히 한 버전만 `true`여야 한다. |
| `source_kind` | `editorial`, `licensed`, `synthetic_test` 중 하나. 실제 직접 작성 원문은 `editorial`을 사용한다. |
| `source_attribution` | 작성자 또는 라이선스 출처. 공백만 있는 값과 PostgreSQL이 저장할 수 없는 NUL 문자는 허용하지 않는다. |
| `content` | 원문 본문. 공백만 있는 값과 NUL 문자는 허용하지 않으며 줄바꿈은 CSV 인용 필드로 보존한다. |

한 행은 `interpretation_versions`의 불변 버전 하나를 나타낸다. `(interpretation_id, version)` 조합은 파일 전체에서 유일해야 한다. 같은 `interpretation_id`의 모든 행은 `card_code`와 정규화된 `locale`이 동일해야 한다. `source_kind`와 `source_attribution`은 각 불변 버전에 속하므로 새 버전에서 변경할 수 있다. version 번호에 빈 구간이 있어도 DB 제약과 동일하게 허용한다.

## 검증 흐름

CLI는 `node scripts/content/validate-content.mjs <csv-file>`로 실행한다.

```text
CSV file
   |
   v
strict parser -> row validation -> interpretation grouping
                                      |
                                      v
                         active candidates per card/locale
                                      |
                                      v
                     count and UTF-8 JSON byte preflight
                                      |
                                      v
                         human report + process exit code
```

검증 단계는 다음과 같다.

1. 파일이 UTF-8이고 헤더가 정확하며 모든 행의 열 수가 같은지 확인한다.
2. 필수값, UUID, locale, 카드 코드 제어 문자, DB 텍스트 필드의 NUL 문자, version 범위, boolean, 허용된 source kind를 확인한다.
3. 중복 `(interpretation_id, version)`과 같은 ID 안의 불일치 필드를 확인한다.
4. 각 interpretation에 활성 버전이 정확히 하나 있는지 확인한다.
5. 카드·locale별 활성 interpretation 후보 수를 계산해 20개 초과를 오류로 처리한다.
6. 활성 후보를 서버 snapshot의 candidate 형태로 직렬화하여 UTF-8 바이트를 계산한다.
7. 카드별 크기와 가장 큰 카드 3장의 후보 합계, 64 KiB 한도까지의 잔여량을 보고한다.

용량 결과는 콘텐츠 후보 부분의 사전 검사다. 실제 runtime context에는 관계, 현재 상황, 질문, 카드 메타데이터, Position이 추가되므로 후보 합계가 64 KiB 미만이어도 리딩 성공을 보장하지 않는다. 후보 합계가 64 KiB에 도달하거나 넘으면 어떤 실제 입력도 한도를 만족할 수 없으므로 오류로 처리한다. 그 미만은 정보성 수치로 출력하고 원문을 자동으로 자르지 않는다.

## 결과와 오류 처리

정상 입력은 카드 수, 원문 수, 활성 버전 수, locale별 후보 수, 바이트 사전 검사 결과를 출력하고 exit code 0으로 끝난다. 경고는 현재 runtime에서 사용하지 않는 locale처럼 데이터 자체는 유효하지만 운영상 확인할 항목에 사용하며 exit code를 바꾸지 않는다.

파싱 또는 계약 오류가 하나라도 있으면 가능한 오류를 모두 수집해 `파일:행:열`과 함께 출력하고 exit code 1로 끝난다. 내부 stack trace 대신 작성자가 고칠 수 있는 메시지를 기본 출력으로 사용한다. 입력 파일을 수정하거나 별도 산출물을 쓰지 않는다.

## 구현 구조

- `scripts/content/csv.mjs`: 문자열에서 CSV 레코드를 파싱하고 원본 행 번호를 유지한다.
- `scripts/content/validate.mjs`: 행 계약, 그룹 불변식, 후보 수와 용량을 순수 함수로 검증한다.
- `scripts/content/validate-content.mjs`: 파일 읽기, 사용자용 보고서, exit code만 담당한다.
- `scripts/content/*.test.mjs`: 파서와 검증 규칙을 Node 기본 test runner로 확인한다.

외부 의존성을 추가하지 않는다. 루트 `package.json`도 콘텐츠 세션 소유 범위가 아니므로 수정하지 않는다.

## 검증 기준

자동 테스트는 최소한 다음 사례를 포함한다.

- 인용된 쉼표·따옴표·여러 줄 한글 본문의 보존
- 잘못된 헤더와 열 수, 닫히지 않은 인용부호
- 빈 본문·출처, 잘못된 UUID·locale·version·boolean·source kind
- 중복 ID/version, 그룹 메타데이터 불일치, 활성 버전 누락·중복
- 카드당 활성 후보 20개 통과와 21개 실패
- UTF-8 JSON 바이트 계산과 64 KiB 도달·초과 실패
- 유효한 `synthetic_test` fixture의 CLI 성공과 손상된 fixture의 CLI 실패

Node 24.12.0에서 단위 테스트와 실제 fixture dry-run을 실행한다. DB, 네트워크, AI API는 사용하지 않는다.

## 통합 전달

후속 DB import는 검증을 통과한 동일 CSV 계약을 입력으로 사용하되 통합 세션에서 별도 설계한다. import는 locale의 검증된 `Intl.Locale` 정규형을 저장하고, 기존 `(interpretation_id, version)`을 수정하지 않고 새 버전을 삽입한 뒤 명시된 활성 버전을 선택해야 한다. 실제 활성화 전에는 카드 코드가 DB catalog에 존재하는지와 기존 DB 버전 충돌을 추가로 확인해야 한다.
