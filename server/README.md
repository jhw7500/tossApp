# Tarororo API foundation

Use Node 24.12 or newer. The source uses Node's built-in erasable TypeScript support, so no runtime TypeScript loader is needed.

## CODE INTEGRATION vs. ACTUAL OPERATIONS

Merging this code only makes the implementation available. It does **not** authorize any of these operations:

- migrate an existing, shared, or production database;
- replace or retire an authentication secret;
- restart the API or worker; or
- deploy a service.

Treat each operation as a separate change. Confirm the target environment, owner, backup or recovery path, and explicit approval before running it. The commands below are local-development examples unless an approved runbook says otherwise.

Start PostgreSQL locally with Docker (supply a password through your shell, not a checked-in file):

```sh
docker run --name tarororo-postgres -e POSTGRES_USER=tarororo -e POSTGRES_PASSWORD -e POSTGRES_DB=tarororo -p 5432:5432 -d postgres:18
```

Copy `.env.example` to `.env`, replace placeholders, and keep `.env` out of source control. Every runtime and test script uses Node 24's `--env-file-if-exists=.env`; values already supplied by the shell take precedence, so CI can inject `TEST_DATABASE_URL` without changing the file. `AUTH_MODE=mock` is allowed only with `APP_ENV=local` or `test` and a loopback `HOST`. Production requires HTTPS non-loopback origins and Toss mTLS settings.

Anonymous-user HMAC keys support versioned rotation. `AUTH_SUBJECT_SECRET` is the active secret, `AUTH_SUBJECT_SECRET_VERSION` identifies it and defaults to `v1`, and optional `AUTH_SUBJECT_PREVIOUS_SECRETS` is a JSON object such as `{"v1":"old-secret-of-at-least-32-characters"}`. Deploy migration 004 and the compatible application code with the current secret first; migration 004 mirrors user inserts made by an older application instance while the rollout completes. Do not change the active secret until every application instance runs the compatible code. To rotate, assign a new active version and secret while retaining the old version and secret in the JSON object. Compatible instances on either version converge because a session transaction registers every configured active and previous HMAC alias. A returning user found through an old HMAC receives an active-key identity alias in the same transaction, preserving sessions, Persons, and Readings under the existing internal user ID.

Keep each previous secret while an identity created under that version may return, including dormant identities. Because the original anonymous key is never stored, an identity that has not returned while its previous secret is configured cannot be converted after that secret is removed. Removing it would cause that identity to be treated as new. Session TTL and elapsed time do not establish that retirement is safe.

Configuration rejects reserved or malformed versions, secrets shorter than 32 characters, reused secrets, an active version repeated in the previous map, and more than eight retained previous versions. The eight-version cap is a bounded compatibility limit, not a retention SLA or permission to discard the oldest key. At capacity, stop rotation until an approved retention and recovery plan identifies how affected dormant identities will be handled. Never silently drop a previous secret to make room.

Install and run the service locally:

```sh
cd server
nvm use
npm ci
npm run db:migrate
npm run db:seed
npm run start
npm run worker
```

Do not aim `db:migrate` or `db:seed` at an existing, shared, or production database without separate operational approval. Do not use this command block to justify a service restart or deployment. `db:seed` is idempotent and refuses production; it creates synthetic test content marked `source_kind=synthetic_test`, not tarot-reader source material.

Run the unit suite with `npm test`. The integration suite uses an actual PostgreSQL database and fails clearly without `TEST_DATABASE_URL` (put it in `.env` locally or provide it through the shell):

```sh
npm test
TEST_DATABASE_URL='postgresql://…' npm run test:integration
```

Each integration test creates and removes only its own schema. Before running against Toss, set `AUTH_MODE=toss` and provide readable mTLS certificate and key paths. The server verifies anonymous keys only against the fixed Apps in Toss endpoint with normal TLS certificate validation; real credentials and an authorized Toss environment are required for that verification.

The API writes one JSON completion event per stdout line with only `requestId`, HTTP status, duration, and a normalized error code when present. Fastify's logger is disabled so its request and internal warning paths cannot emit URLs, client addresses, headers, or request bodies; startup and shutdown use separate bounded JSON events. The request event never contains session or anonymous keys, user fields, questions, source text, or response content. During graceful shutdown, a request already accepted on an existing connection finishes through the normal request lifecycle instead of Fastify's unobserved early-503 path.

Stdout delivery is best effort. While the sink is backpressured, the process drops new events until `drain`. After a sink error or thrown write, it permanently stops further writes for that process. These failures do not change HTTP or worker results. Do not claim audit completeness from these events, and do not assume this implementation provides a metric for dropped or disabled writes.


## Reading API

Apply migrations through `npm run db:migrate`; 003 adds the Reading flow and 004 backfills versioned anonymous-user identity aliases without resetting existing data or changing earlier migrations. Seed creates three independent synthetic sources per card, initializes each new source's active version, and preserves existing active choices on repeat runs. Change source text by inserting an `interpretation_versions` row and switching `interpretations.active_version`; existing versions cannot be updated. Question content and card-position mutations automatically increment the question version.

All routes below require a Bearer session. Create/retry also require an `Idempotency-Key` UUID. Unknown request fields are rejected. CORS permits this header.

| Method | Route | Response |
| --- | --- | --- |
| POST | `/v1/readings` | 202 accepted; 200 replay |
| GET | `/v1/readings/:readingId` | Current state, frozen public input, result/error |
| POST | `/v1/readings/:readingId/retry` | 202 accepted; 200 replay |
| GET | `/v1/persons/:personId/readings` | `{items,nextCursor}`; latest first |

Create body: `{personId,personVersion,question:{id,version,customText?},selections:[{positionIndex,cardId}]}`. Supply three distinct cards at positions 1, 2, 3. Recommended questions forbid `customText`; custom templates require 1-500 trimmed Unicode code points and work with every relationship. Retry body: `{expectedAttemptNo}`. Acceptance: `{readingId,status,attemptNo,statusUrl}`.

UUID case, selection order, and surrounding custom-text whitespace do not change request identity. Replay resolves the original key's attempt before examining current Person/content versions. A reused key with different input returns `409 IDEMPOTENCY_CONFLICT`. One user can have one active reading; additional active requests return `429 RATE_LIMITED`. Person/question changes return `409 STALE_VERSION`; unavailable content returns `422 CONTENT_UNAVAILABLE`. Context over 20 sources per card or 64 KiB is rejected with `CONTENT_CONTEXT_LIMIT` without truncating sources. Synthetic sources are refused in production.

Detailed output: `{id,personId,status,attemptNo,createdAt,updatedAt,input,result,error,aiGenerated,testContent}`. Public input contains Person nickname/relationship/situation, question ID/version/text/custom flag, and selected card ID/name/position/label. Candidate sources, execution leases, and prompts stay private. History items contain `{id,status,question,summary,createdAt}`; `question` is the frozen question text, `summary` is null until success. Cursor pagination defaults to 20, caps at 100, and preserves PostgreSQL microsecond ordering. Foreign and missing resources both return 404.

Person list/detail/create/patch outputs include `readingCount` and `lastReadingAt`, derived only from successful readings. Question catalogs include `version` and all three `{position,label,description}` entries, plus the active custom template. Card catalogs exclude cards with no readable active source. HTTP errors use `{error:{code,message,retryable,requestId}}` and never expose internal error bodies.

## Worker boundary

The API stores and transitions jobs; the separate AI worker consumes these interfaces. No AI call happens in the API process.

Run the worker as a separate process with `AI_PROVIDER=gemini`, `AI_MODEL` (default `gemini-3.1-flash-lite`), and `GEMINI_API_KEY` in its environment. The key stays server-side. The worker uses the fixed official Generate Content endpoint, rejects redirects, caps requests at 20 seconds and responses at 256 KiB, and never automatically retries a provider call. `SIGINT` and `SIGTERM` abort in-flight generation, stop new claims, and close the worker database pool.

The worker writes one JSON lifecycle event per stdout line at attempt start and finish. Events contain only internal Reading/attempt IDs, attempt number, provider, model, duration, terminal status, token usage on success, or a safe error code on failure. A late result for an expired claim is reported as `STALE`. Events never contain session or anonymous keys, Person fields, question/source text, generated output, provider error bodies, or credentials. The best-effort stdout limits above apply to worker events; logging failures are isolated from processing and do not change persistence or retry behavior.

The worker reads only `DATABASE_URL` and AI settings; API identity secrets and Toss mTLS files are not required by the worker. The PC test deployment mounts role-specific secrets at runtime and maintains a separate test database; see [deployment instructions](../deploy/pc-test/README.md).

```typescript
import { claimNextReading, completeReading, failReading, expireReadings } from './src/readings/attempts.ts';
import { toReadingContext } from './src/readings/snapshot.ts';
import type { ReadingClaim, ReadingResult, ReadingUsage } from './src/readings/types.ts';
```

`claimNextReading(pool,{provider,model})` returns a `ReadingClaim | null`. Claim fields are `readingId`, `attemptId`, `attemptNo`, `snapshot`, `promptVersion`, `contractVersion`, and `leaseExpiresAt`. `toReadingContext(snapshot)` omits the Person ID and nickname. Schema sources are `../contracts/reading.schemas.ts`; server types derive from them in `src/readings/types.ts`.

`completeReading(pool,claim,{result,usage,aiGenerated})` and `failReading(pool,claim,{code,message,retryable})` return false for a stale/nonrunning/expired claim. Completion validates the result structure and every card/evidence pair against the stored snapshot and candidate rows, then commits result, selected evidence, and both statuses together. Usage is null or `{inputTokens?,outputTokens?,totalTokens?}`. Failure messages are replaced with a bounded public message rather than persisting provider bodies.

State transitions: `QUEUED -> RUNNING -> SUCCEEDED | FAILED`; only an explicit retry creates the next attempt on the same reading. Maximum attempts: 3. Queue deadline: 60 seconds. Worker lease: 45 seconds. Shared versions: `reading-result.v1`, `tarot-grounded.v1`. Malformed JSON, schema, or evidence output fails without storing a result and remains manually retryable while an attempt remains. Configuration and unsupported contract/prompt versions, provider request rejection, and explicit policy refusal are nonretryable. `expireReadings(pool)` closes expired jobs; detail and retry also expire their target without a worker. Claim uses `FOR UPDATE SKIP LOCKED`, and mutation paths lock Reading before attempt. No database transaction remains open across an external call.

The integration suite exercises snapshots, active versions and FK constraints, idempotency races, owner isolation, context bounds, Unicode whitespace, worker locking, queue/lease expiry, explicit retries, stale completions, atomic evidence validation, successful Person aggregates, and database reconnection. It uses isolated schemas and makes no external AI calls. Synthetic fixtures verify mechanics only, not tarot-reader content quality.

## Grounded-reading quality review

The runtime validator proves that every result has the required shape and cites
available source IDs and versions. Meaning preservation still requires a human
review. Prepare an isolated JSON fixture containing the exact `ReadingContext`,
the generated `ReadingResult`, and one verdict for each rubric item, then run:

```sh
npm run quality:evaluate -- fixtures/quality/synthetic-mechanics.json
```

Review all candidates shown for each card, not only the cited candidates:

| Rubric field | Pass condition |
| --- | --- |
| `meaningPreservation` | Card text neither invents nor reverses the cited source meaning. |
| `evidenceSelection` | Selected sources fit the question and card position better than the unused candidates. |
| `questionContext` | Card text addresses the supplied relationship, situation, question, and position. |
| `overallFlow` | The overall reading connects the three cards instead of repeating them. |
| `nonDefinitiveLanguage` | The result uses reflective, possible language rather than certain prediction. |

Every field must pass for a reader-content `PASS`, and a human reader must perform that review. If any candidate has
`sourceKind=synthetic_test`, the command always returns `MECHANICS_ONLY`, even
when every rubric field says `pass`. The included fixture checks the procedure
and must not be recorded as evidence of tarot-reader content quality or a
reader-content `PASS`. Use
controlled evaluation scenarios rather than real user names or private input.
