# 타로 원문 작성과 dry-run 검증

이 문서는 타로리더가 카드별 복수 원문을 스프레드시트에서 작성하고, 개발자가 DB 반영 전에 입력 계약을 확인하는 방법을 설명한다. 검증 명령은 CSV를 읽기만 하며 입력 파일, DB, migration, seed를 변경하지 않는다.

## 작성 시작

저장소 루트에서 [입력 템플릿](../../content/interpretations.template.csv)을 작업 파일로 복사한다. 템플릿은 헤더만 포함하므로 원문 행을 추가하기 전에는 검증을 통과하지 않는다.

```sh
cp content/interpretations.template.csv content/my-interpretations.csv
```

복사한 파일을 엑셀이나 구글시트에서 연다. 원문 한 버전을 한 행에 입력하고 `CSV UTF-8` 형식으로 내보낸다. 본문 안의 쉼표, 따옴표, 줄바꿈은 한 셀 안에 유지한다. 스프레드시트가 내보낼 때 필요한 CSV 인용부호를 붙이므로 직접 분리하지 않는다.

실제 형식은 [합성 테스트 예제](../../content/fixtures/synthetic-test.csv)에서 볼 수 있다. 이 예제의 문장은 도구 검증용이며 실제 타로 해석으로 사용하지 않는다.

## 입력 열

열 이름과 순서를 바꾸지 않는다.

| 열 | 작성 규칙 |
| --- | --- |
| `card_code` | 개발자가 제공한 카드 코드를 입력한다. 제어 문자를 포함할 수 없으며 같은 원문의 모든 버전에서 유지한다. |
| `interpretation_id` | 원문 하나를 식별하는 UUID다. 내용을 수정해 새 버전을 만들 때도 같은 UUID를 유지한다. |
| `locale` | 한국어 운영 원문은 `ko-KR`로 입력한다. 검증기는 유효한 태그를 `Intl.Locale` 정규형으로 비교한다. |
| `version` | 첫 버전은 `1`이며 변경할 때 2147483647 이하의 더 큰 정수로 새 행을 추가한다. 이전 행의 본문·출처·version은 덮어쓰지 않는다. |
| `is_active_version` | 현재 사용할 버전 하나만 `true`, 나머지 버전은 `false`로 입력한다. 새 버전을 활성화할 때 이전 행에서는 이 표시만 `false`로 바꾼다. |
| `source_kind` | 직접 작성은 `editorial`, 사용 권리를 확보한 외부 원문은 `licensed`, 도구 시험 자료만 `synthetic_test`다. |
| `source_attribution` | 작성자 표시 또는 라이선스 출처를 공백 없이 기록한다. NUL 문자는 사용할 수 없다. |
| `content` | 타로리더가 작성한 원문 본문이다. 공백만 입력하거나 NUL 문자를 포함할 수 없다. |

새 원문에는 개발자가 발급한 UUID를 사용한다. 개발자가 로컬에서 UUID 하나를 만들 때는 Node 24에서 다음 명령을 사용할 수 있다.

```sh
node -e "console.log(crypto.randomUUID())"
```

예를 들어 version 1을 교정하려면 기존 행의 본문·출처·version을 보존하고 활성 표시만 `false`로 바꾼다. 같은 `interpretation_id`와 version 2를 가진 새 행에 교정문을 기록하고 활성 표시를 `true`로 둔다. 한 원문의 활성 버전은 반드시 하나다.

## 검증 실행

Node 24.12.0 이상을 사용해 저장소 루트에서 실행한다.

```sh
node scripts/content/validate-content.mjs content/my-interpretations.csv
```

정상 파일은 카드·원문·활성 버전 수와 카드/locale별 후보 수·UTF-8 JSON 바이트를 출력하고 종료 코드 0을 반환한다. 오류가 있으면 `파일:행:열` 형식으로 가능한 문제를 모아서 출력하고 종료 코드 1을 반환한다.

저장소의 정상 예제를 직접 확인할 수 있다.

```sh
node scripts/content/validate-content.mjs content/fixtures/synthetic-test.csv
```

`invalid-missing-active.csv`는 오류 보고를 시험하기 위한 의도적인 실패 자료다.

## 검증 범위

dry-run은 다음 항목을 확인한다.

- 정확한 헤더와 행별 열 수
- 필수값, UUID, locale, 제어 문자가 없는 카드 코드, DB 텍스트 필드의 NUL 문자, 1~2147483647 범위의 정수 version, boolean, source kind
- 중복된 `(interpretation_id, version)`
- 같은 원문 이력 안에서 변경된 카드 또는 locale
- 원문마다 정확히 하나인 활성 버전
- 카드·locale당 활성 후보 최대 20개
- 활성 후보를 런타임 candidate JSON 형태로 직렬화한 UTF-8 바이트
- 가장 큰 `ko-KR` 카드 세 장의 후보 합계가 64 KiB를 넘는 명백한 실패

64 KiB 결과는 원문 후보 부분만 계산한다. 실제 리딩 context에는 관계, 현재 상황, 질문, 카드 메타데이터와 Position이 추가된다. 따라서 잔여 바이트가 양수여도 실제 모든 질문 조합의 성공을 보장하지 않으며, 도구는 한도를 맞추기 위해 원문을 자르지 않는다.

현재 서버는 정확히 `ko-KR`인 활성 원문만 사용한다. 검증기는 정규화 결과가 `ko-KR`인 태그를 같은 locale로 계산하며, 다른 유효한 locale은 데이터 오류로 보지 않지만 사용 전 확인하도록 경고한다. 후속 import도 검증된 정규형을 저장해야 한다.

검증 통과는 DB import나 콘텐츠 활성화를 뜻하지 않는다. 통합 단계에서는 카드 코드가 DB catalog에 존재하는지, 같은 UUID/version이 이미 저장되어 있지 않은지 확인한 뒤 별도 import 절차를 거쳐야 한다.

## 도구 테스트

DB와 네트워크 없이 전체 콘텐츠 도구 테스트를 실행한다.

```sh
node --test scripts/content/*.test.mjs
```
