# Tarororo API foundation

Use Node 24.12 or newer. The source uses Node's built-in erasable TypeScript support, so no runtime TypeScript loader is needed.

Start PostgreSQL locally with Docker (supply a password through your shell, not a checked-in file):

```sh
docker run --name tarororo-postgres -e POSTGRES_USER=tarororo -e POSTGRES_PASSWORD -e POSTGRES_DB=tarororo -p 5432:5432 -d postgres:18
```

Copy `.env.example` to `.env`, replace placeholders, and keep `.env` out of source control. Every runtime and test script uses Node 24's `--env-file-if-exists=.env`; values already supplied by the shell take precedence, so CI can inject `TEST_DATABASE_URL` without changing the file. `AUTH_MODE=mock` is allowed only with `APP_ENV=local` or `test` and a loopback `HOST`. Production requires HTTPS non-loopback origins and Toss mTLS settings.

Install and run the service:

```sh
cd server
nvm use
npm ci
npm run db:migrate
npm run db:seed
npm run start
npm run worker
```

`db:seed` is idempotent and refuses production. It creates synthetic test content marked `source_kind=synthetic_test`; it is not tarot-reader source material.

Run the unit suite with `npm test`. The integration suite uses an actual PostgreSQL database and fails clearly without `TEST_DATABASE_URL` (put it in `.env` locally or provide it through the shell):

```sh
npm test
TEST_DATABASE_URL='postgresql://…' npm run test:integration
```

Each integration test creates and removes only its own schema. Before running against Toss, set `AUTH_MODE=toss` and provide readable mTLS certificate and key paths. The server verifies anonymous keys only against the fixed Apps in Toss endpoint with normal TLS certificate validation; real credentials and an authorized Toss environment are required for that verification.


## Reading API

Apply migrations through `npm run db:migrate`; 003 extends the foundation without resetting existing data or changing 001/002. Seed creates three independent synthetic sources per card, initializes each new source's active version, and preserves existing active choices on repeat runs. Change source text by inserting an `interpretation_versions` row and switching `interpretations.active_version`; existing versions cannot be updated. Question content and card-position mutations automatically increment the question version.

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

```typescript
import { claimNextReading, completeReading, failReading, expireReadings } from './src/readings/attempts.ts';
import { toReadingContext } from './src/readings/snapshot.ts';
import type { ReadingClaim, ReadingResult, ReadingUsage } from './src/readings/types.ts';
```

`claimNextReading(pool,{provider,model})` returns a `ReadingClaim | null`. Claim fields are `readingId`, `attemptId`, `attemptNo`, `snapshot`, `promptVersion`, `contractVersion`, and `leaseExpiresAt`. `toReadingContext(snapshot)` omits the Person ID and nickname. Schema sources are `../contracts/reading.schemas.ts`; server types derive from them in `src/readings/types.ts`.

`completeReading(pool,claim,{result,usage,aiGenerated})` and `failReading(pool,claim,{code,message,retryable})` return false for a stale/nonrunning/expired claim. Completion validates the result structure and every card/evidence pair against the stored snapshot and candidate rows, then commits result, selected evidence, and both statuses together. Usage is null or `{inputTokens?,outputTokens?,totalTokens?}`. Failure messages are replaced with a bounded public message rather than persisting provider bodies.

State transitions: `QUEUED -> RUNNING -> SUCCEEDED | FAILED`; only an explicit retry creates the next attempt on the same reading. Maximum attempts: 3. Queue deadline: 60 seconds. Worker lease: 45 seconds. Shared versions: `reading-result.v1`, `tarot-grounded.v1`. Malformed JSON, schema, or evidence output fails without storing a result and remains manually retryable while an attempt remains. Configuration and unsupported contract/prompt versions, provider request rejection, and explicit policy refusal are nonretryable. `expireReadings(pool)` closes expired jobs; detail and retry also expire their target without a worker. Claim uses `FOR UPDATE SKIP LOCKED`, and mutation paths lock Reading before attempt. No database transaction remains open across an external call.

The integration suite exercises snapshots, active versions and FK constraints, idempotency races, owner isolation, context bounds, Unicode whitespace, worker locking, queue/lease expiry, explicit retries, stale completions, atomic evidence validation, successful Person aggregates, and database reconnection. It uses isolated schemas and makes no external AI calls. Synthetic fixtures verify mechanics only, not tarot-reader content quality.
