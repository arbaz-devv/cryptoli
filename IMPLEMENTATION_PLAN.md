# Implementation Plan: Complete Test Coverage

> **Created:** 2026-03-19 | **Baseline:** 11.13% statements, 45 tests, 10 spec files
> **Current:** 75.73% statements, 335 tests, 33 spec files
> **Goal:** 85%+ statements, 80%+ branches/functions across all `src/` modules
> **Spec:** See `specs/testing-strategy.md` for conventions, patterns, and infrastructure

> **IMPORTANT — Rules for modifying this file:**
> - You may ONLY check off items (`[ ]` → `[x]`) and append learnings under `> **Learnings:**` blocks
> - You may ONLY add items to the "Remaining Gaps" section at the bottom
> - Do NOT delete task descriptions, rewrite phases, rename the document, add new phases, or restructure
> - Do NOT change any source files under `src/` unless a test reveals a genuine bug
> - This file is the source of truth for testing scope — feature work belongs on a different branch

---

## Phase 0: Test Infrastructure Setup — DONE
> Foundation that all other phases depend on.

- [x] **0.1 — Install TestContainers and isolation dependencies**
  - `npm install -D testcontainers @testcontainers/postgresql nock`
  - `nock` blocks all outbound HTTP in integration/e2e tests (prevents `ipwho.is` calls, push notifications, etc.)
  - Verify Docker is available in dev environment

- [x] **0.2 — Create `.env.test`**
  - `NODE_ENV=test`
  - `JWT_SECRET=test-jwt-secret-at-least-32-characters-long`
  - `CORS_ORIGIN=http://localhost:3000`
  - `ADMIN_API_KEY=test-admin-key`
  - `ANALYTICS_API_KEY=test-analytics-key`
  - `ADMIN_EMAIL=admin@test.com`
  - `DATABASE_URL` and `REDIS_URL` intentionally **absent** — injected at runtime by TestContainers (never hardcoded, never pointing to real services)
  - `ADMIN_PASSWORD_HASH` generated in globalSetup from `'testpassword'`
  - **VAPID keys intentionally absent** — push service no-ops (prevents sending real push notifications)
  - Safe to commit — all values are test-only, no real credentials
  - **IMPORTANT:** `.env.test` is NOT auto-loaded by `dotenv`. The globalSetup explicitly reads it or sets env vars manually. This prevents `.env` (with real credentials) from being loaded first via `import 'dotenv/config'` in `main.ts`.

- [x] **0.3 — Create TestContainers global setup/teardown with three-phase boot sequence**
  - `test/helpers/test-db.setup.ts` — the critical safety file. Three phases, strict order:
    - **Phase 1 — Provision:** Start PostgreSQL 16 + Redis 7 containers, run `prisma migrate deploy`, construct test clients with **explicit URLs** from containers (not from `process.env`)
    - **Phase 2 — Validate (gate):** Before any test runs, verify:
      - Database is reachable and all expected tables exist (migrations succeeded)
      - Database is empty (no stale data from a crashed prior run)
      - Redis is reachable (PING → PONG)
      - Both hosts are localhost (structural guarantee)
      - Dangerous credentials (`VAPID_*`) are NOT in environment
      - **If ANY check fails → stop containers, throw with full diagnostic, zero tests run**
    - **Phase 3 — Expose:** Store validated URLs on `globalThis.__TEST_DATABASE_URL__` and `globalThis.__TEST_REDIS_URL__` for test file access. Clear dangerous env vars, then set `process.env` as secondary path (for AppModule bootstrap in e2e). Block outbound HTTP via `nock.disableNetConnect()` (localhost only allowed).
  - `test/helpers/test-db.teardown.ts` — stops containers, re-enables network via `nock.enableNetConnect()`
  - `test/helpers/test-db.utils.ts`:
    - `getTestPrisma()` — reads from `globalThis.__TEST_DATABASE_URL__` (not `process.env`), validates localhost, constructs client with `datasourceUrl` (bypasses `.env` auto-loading)
    - `getTestRedisUrl()` — same pattern for Redis
    - `truncateAll()` — respects FK order (children first, 19 tables)
    - `isLocalhostUrl()` — shared URL validator
  - See `specs/testing-strategy.md` → "Isolation Guarantees" for full implementation code and threat model

- [x] **0.4 — Create shared unit test mock factories (`test/helpers/`)**
  - `prisma.mock.ts` — reusable PrismaService mock with `$transaction` callback unwrapping, per-model jest.fn() stubs
  - `redis.mock.ts` — RedisService mock with `isReady()` toggle
  - `socket.mock.ts` — SocketService mock with all 7 emit methods as `jest.fn()`
  - `auth.helpers.ts` — `createMockSessionUser()`, `createTestJwt()`, `mockRequest()`, `mockExecutionContext()`

- [x] **0.5 — Create test data factory functions (`test/helpers/factories.ts`)**
  - `createTestUser(prisma, overrides)` — with bcrypt cost 1 for speed
  - `createTestCompany(prisma, overrides)`
  - `createTestReview(prisma, authorId, overrides)` — defaults to APPROVED
  - `createTestComplaint(prisma, authorId, overrides)`
  - `createTestComment(prisma, authorId, reviewId, overrides)`
  - Auto-incrementing counter for unique emails/slugs

- [x] **0.6 — Create E2E app bootstrap helper (`test/helpers/setup-app.ts`)**
  - Replicates `main.ts` middleware: Helmet, CORS, CSRF, ValidationPipe, AllExceptionsFilter
  - Boots real `AppModule` but **overrides PrismaService and RedisService** with explicitly-constructed test instances (from `getTestPrisma()` / `getTestRedisUrl()` — not from `process.env`)
  - `setupTestApp()` returns `{ app, server }`, `teardownTestApp(app)` calls `app.close()`
  - **The override is the primary isolation** — even if `.env` has production credentials, the overridden providers point to TestContainers

- [x] **0.7 — Create jest config files**
  - `test/jest-integration.json` — `rootDir: "."`, `testRegex: "test/integration/.*\\.spec\\.ts$"`, `globalSetup/globalTeardown` pointing to TestContainers setup, timeout 30000ms
  - Update `test/jest-e2e.json` — same globalSetup/globalTeardown, `testRegex: "test/e2e/.*\\.e2e-spec\\.ts$"`, timeout 60000ms
  - Update `package.json` jest config — add `collectCoverageFrom` exclusions (`*.module.ts`, `main.ts`, `*.dto.ts`, `api.controller.ts`, `data.service.ts`), add `coverageThreshold` (80/80/85/85)

- [x] **0.8 — Add npm scripts**
  - `test:integration` → `jest --config test/jest-integration.json`
  - `test:e2e` → `jest --config test/jest-e2e.json`
  - `test:all` → `npm test && npm run test:integration && npm run test:e2e`

> **Learnings:**
> - `@types/nock` also installed (nock v14 needs it)
> - Test helpers compile via ts-jest at runtime; `npx tsc --noEmit` excludes `test/` per `tsconfig.build.json`
> - Coverage threshold (80/80/85/85) added to package.json but only gates `test:cov` runs
> - All 45 existing unit tests pass after infrastructure changes
> - Jest `globalSetup` runs in separate process; `globalThis` doesn't propagate to workers — `process.env` fallback needed in `getTestPrisma()`
> - `truncateAll()` uses dynamic `pg_tables` query instead of hardcoded list — more resilient to schema changes

---

## Phase 1: Security-Critical Unit Tests (P0) — DONE (90 tests)
> Auth, guards, session management — highest risk if broken. All mocked (Tier 1).

- [x] **1.1 — `src/auth/auth.guard.spec.ts`** — 5 tests
  - canActivate: returns true + sets `req.user` when session valid
  - canActivate: throws UnauthorizedException when no token
  - canActivate: throws UnauthorizedException when token expired/invalid
  - canActivate: throws UnauthorizedException when DB session missing
  - Token extraction: Bearer header > cookie > raw cookie header priority

- [x] **1.2 — `src/auth/optional-auth.guard.spec.ts`** — 5 tests
  - Always returns true (never blocks)
  - Sets `req.user` to SessionUser when session valid
  - Sets `req.user` to `null` (not `undefined`) when no session

- [x] **1.3 — Expand `src/auth/auth.service.spec.ts`** — 29 tests (expanded from 9)
  - `createUser`: hashes password, returns profile without passwordHash
  - `hashPassword` / `comparePassword`: bcrypt round-trip
  - `createSession`: JWT payload contains `{ userId, jti }`, 7-day expiry
  - `getSessionFromToken`: rejects expired JWT, rejects valid JWT with deleted DB session
  - `getSessionTokenFromRequest`: Bearer > cookie > raw header priority chain
  - `updateProfile`: trims bio, converts empty to null
  - `generateUsernameSuggestions`: returns available candidates

- [x] **1.4 — `src/auth/auth.controller.spec.ts`** — 22 tests
  - POST /register: Zod validation (email, username 3-30, password min 8)
  - POST /register: creates user + session, sets cookie
  - POST /register: rejects duplicate email/username
  - POST /login: validates credentials, sets cookie
  - POST /login: rejects wrong password (no enumeration)
  - POST /logout: clears session from DB + cookie
  - GET /me: returns user when authenticated, null when not
  - PATCH /me: updates profile, handles P2002 uniqueness
  - POST /change-password: verifies old password, rotates session
  - Rate limiting metadata: 5/60s on login and register

- [x] **1.5 — Expand `src/admin/admin.guard.spec.ts`** — 11 tests (expanded from 4)
  - JWT-based admin auth: valid admin JWT accepted
  - JWT-based admin auth: non-admin JWT rejected, expired JWT rejected
  - Missing/undefined/whitespace `ADMIN_API_KEY` behavior

- [x] **1.6 — `src/admin/admin-auth.service.spec.ts`** — 10 tests
  - `isLoginEnabled`: true when both email + hash configured, false when either missing
  - `login`: returns JWT with `type: 'admin'` claim, 24h expiry
  - `login`: throws UnauthorizedException for wrong email/password/unconfigured

- [x] **1.7 — `src/common/http-exception.filter.spec.ts`** — 8 tests
  - HttpException: extracts status + message
  - HttpException with errors array: passes through
  - Non-HttpException: delegates to `handleError()`, returns sanitized 500
  - Response shape: `{ error }` or `{ error, errors }`

---

## Phase 2: Data Integrity Unit Tests (P1) — DONE (52 tests)
> Voting, transactions, recounts — data corruption risk. All mocked (Tier 1).

- [x] **2.1 — Expand `src/reviews/reviews.service.spec.ts`** — 19 tests (expanded from 6)
  - `vote()`: all toggle logic (new/same/opposite), recount with `count()`, notification conditions, socket emit ordering, invalid voteType rejection
  - `create()`: Zod validation, auto-approve, score computation, socket emit
  - `list()`: pagination, filters, APPROVED-only, userVote enrichment
  - `getById()`: NotFoundError, includes comments

- [x] **2.2 — `src/complaints/complaints.service.spec.ts`** — 16 tests
  - `vote()`: full transaction-recount, toggle logic, invalid voteType
  - `create()`: Zod validation, status OPEN
  - `list()`: pagination, userVote enrichment
  - `getById()`: NotFoundError, userVote
  - `reply()`: Zod validation, OPEN→IN_PROGRESS transition, missing complaint/company errors

- [x] **2.3 — `src/comments/comments.service.spec.ts`** — 17 tests
  - `vote()`: transaction-recount, toggle logic, notification conditions
  - `create()`: Zod validation, exactly-one-target enforcement, socket emit (review only), notifications
  - `list()`: top-level + nested replies, userVote enrichment
  - `getById()`: `id === 'list'` fallback

> **Learnings:**
> - Feed service uses chunked merge-sort; mocks must use `mockResolvedValueOnce` then return `[]` for subsequent calls

---

## Phase 3: Core Business Logic Unit Tests (P2) — DONE (51 tests)
> Complex services. All mocked (Tier 1).

- [x] **3.1 — `src/users/users.service.spec.ts`** — 14 tests
  - `getPublicProfile()`: cache hit/miss, Redis failure fallback, viewerState never cached
  - `followUser()`: creates Follow, self-follow rejection, duplicate idempotent, cache invalidation
  - `unfollowUser()`: deletes Follow, self-unfollow rejection, cache invalidation
  - `getFollowStatusBulk()`: deduplication, cap at 50, excludes self

- [x] **3.2 — `src/notifications/notifications.service.spec.ts`** — 6 tests
  - `createForUser()`: DB record + socket emit + push (push error swallowed)
  - `listForUser()`: last 25 + unreadCount
  - `markRead()`: ownership check, socket emit
  - `markAllRead()`: bulk update + socket emit

- [x] **3.3 — `src/notifications/push.service.spec.ts`** — 3 tests *(PARTIAL — see Remaining Gaps)*
  - `onModuleInit()`: VAPID configured/not-configured
  - `registerSubscription()`: upserts by endpoint
  - `sendToUser()`: no-op when VAPID absent, sends to all, auto-deletes stale on 410/404

- [x] **3.4 — `src/feed/feed.service.spec.ts`** — 4 tests
  - `getFeed()`: merges reviews + complaints by createdAt desc, APPROVED filter, type discriminator, pagination, empty results

- [x] **3.5 — `src/search/search.service.spec.ts`** — 6 tests
  - `search()`: empty query, per-entity search, type filter, limit

- [x] **3.6 — `src/trending/trending.service.spec.ts`** — 4 tests
  - `getTrending()`: period handling, ordering, field mapping

- [x] **3.7 — `src/companies/companies.service.spec.ts`** — 8 tests
  - `list()`: pagination, category/search filters
  - `getBySlug()`: averageScore, NotFoundError

> **Learnings:**
> - Users service requires RedisService mock (via `createRedisMock`) in addition to Prisma mock
> - `follow.deleteMany` was missing from prisma mock — added it

---

## Phase 4: Infrastructure Unit Tests (P4) — DONE (69 tests)
> Redis, Socket, Config, Utilities. All mocked (Tier 1).

- [x] **4.1 — `src/common/utils.spec.ts`** — 30 tests
  - `hashPassword` / `verifyPassword` round-trip
  - `calculateOverallScore()`: known weights, unknown keys
  - All 8 Zod schemas: valid passes, invalid rejects with correct messages

- [x] **4.2 — `src/config/config.service.spec.ts`** — 11 tests
  - Getter correctness, `jwtSecret` production guard, `isProduction`

- [x] **4.3 — `src/config/env.schema.spec.ts`** — 7 tests
  - `validateEnv()`: valid/invalid env, defaults

- [x] **4.4 — `src/socket/socket.service.spec.ts`** — 10 tests
  - All 7 emit methods: no-op when undefined, correct room + event name when defined

- [x] **4.5 — `src/redis/redis.service.spec.ts`** — 9 tests
  - `onModuleInit()`: client creation / no-op, `isReady()`, `onModuleDestroy()`

- [x] **4.6 — `src/prisma/prisma.service.spec.ts`** — 2 tests
  - `onModuleDestroy()`: calls `$disconnect`

> **Learnings:**
> - Zod refinement for JWT_SECRET in production fires during `validateEnv()`, before `ConfigService.jwtSecret` getter
> - ioredis must be jest.mock'd to avoid real connections; fire event handlers manually via stored references

---

## Phase 5: Admin Module Unit Tests (P3) — DONE (31 tests)
> Admin business logic. All mocked (Tier 1).

- [x] **5.1 — Expand `src/admin/admin.service.spec.ts`** — 19 tests (expanded from 2)
  - `getStats()`, `getUsers()`, `getUserDetail(lazy/full)`, `getReview(lazy/full)`, `getReviews()`, `updateReviewStatus()`, `getRatings()`, cache TTL behavior

- [x] **5.2 — `src/admin/admin.controller.spec.ts`** — 10 tests
  - AdminGuard on all endpoints, pagination clamping, delegation to service

- [x] **5.3 — Expand `src/admin/admin-auth.controller.spec.ts`** — 2 tests *(PARTIAL — see Remaining Gaps)*
  - Login flow (valid/invalid credentials), config endpoint

> **Learnings:**
> - Admin caches are module-level — tests sharing cache keys hit stale data
> - `review.groupBy` was missing from prisma mock — added it
> - Admin service uses `$queryRaw` with BigInt return — mock must return `[{ count: BigInt(n) }]`

---

## Phase 6: Analytics Unit Tests (P2) — DONE (29 tests) *(SHALLOW — see Remaining Gaps)*
> Most complex module — 1098 lines, 25+ Redis keys. All mocked (Tier 1).

- [x] **6.1 — `src/analytics/analytics.service.spec.ts`** — 16 tests
  - `track()`: no-op when Redis not ready or consent false
  - `track()`: page_view/like/funnel/page_leave write correct Redis keys
  - `getStats()`: emptyStats fallback, 1-minute cache, date range aggregation
  - `getRealtime()`: active sessions from last 5 minutes
  - `resolveCountry()`: CDN hint > cache > geoip > external API priority
  - `normalizePath()`, `sanitizeLabel()`: transformation correctness
  - `isHealthy()`: PING check

- [x] **6.2 — `src/analytics/analytics.controller.spec.ts`** — 13 tests
  - IP extraction priority chain, guard requirements per endpoint
  - Helper functions: normalizeIp, isPrivateOrLocalIp, pickBestIp, getClientIp, getCountryHint

> **Learnings:**
> - Redis mock needed `pfadd`, `pfcount`, `incrby`, `zremrangebyscore` for analytics service
> - Analytics service uses fire-and-forget patterns — tests verify key writes were initiated

---

## Phase 7: Integration Tests (Tier 2 — Real Database) — DONE (38 tests)
> Verify that Prisma queries, transactions, and constraints actually work. Requires Docker.

- [x] **7.1 — `test/integration/auth-sessions.spec.ts`** — 4 tests
  - Create session → lookup by hashed token → found
  - Create session → delete → lookup → not found
  - Delete other sessions → only current session survives
  - User deletion cascades to sessions

- [x] **7.2 — `test/integration/reviews-voting.spec.ts`** — 5 tests
  - Vote UP → helpfulCount is 1 in DB
  - Vote UP then UP again → vote deleted, helpfulCount is 0
  - Vote UP then DOWN → switches, counts correct
  - Concurrent votes from different users → counts still accurate (no drift)
  - @@unique(userId, reviewId) rejects duplicate via direct Prisma (bypassing service toggle)

- [x] **7.3 — `test/integration/complaints-voting.spec.ts`** — 8 tests
  - Same patterns as reviews-voting but on ComplaintVote
  - Reply creates ComplaintReply record
  - Reply transitions complaint status OPEN → IN_PROGRESS

- [x] **7.4 — `test/integration/comments-voting.spec.ts`** — 7 tests
  - CommentVote transaction-recount
  - Comment creation with parentId creates threaded reply
  - Comment on review updates actual comment count

- [x] **7.5 — `test/integration/follows.spec.ts`** — 4 tests
  - Follow creates record, unfollow deletes
  - Self-follow rejected
  - @@unique(followerId, followingId) prevents duplicate
  - User deletion cascades Follow records
  - CompanyFollow same patterns

- [x] **7.6 — `test/integration/cascade-deletes.spec.ts`** — 4 tests
  - Delete User → verify 14+ dependent tables are empty
  - Delete Company → Products, Reviews, CompanyFollows, Complaints, ComplaintReplies gone
  - Delete Review → Comments, HelpfulVotes, Reactions, Media gone
  - Delete Comment → child Comments, CommentVotes, Reactions gone

- [x] **7.7 — `test/integration/analytics-tracking.spec.ts`** — 6 tests *(requires Redis container)*
  - `track()` page_view → Redis keys exist with correct values
  - `getStats()` → aggregated data matches what was tracked
  - `getRealtime()` → active sessions reflect recent tracks
  - Redis unavailable → graceful no-op (stop Redis container mid-test)

> **Learnings:**
> - Integration tests must run with `maxWorkers: 1` — parallel `TRUNCATE ... CASCADE` causes deadlocks between test suites sharing the same PostgreSQL container
> - `jest-integration.json` now has `forceExit: true` to handle the `getTestRedis()` singleton lingering after globalTeardown
> - Analytics `track()` uses fire-and-forget (`void Promise.all(...)`) — integration tests need a small delay + Redis PING round-trip before asserting on written keys
> - `toHaveProperty('google.com')` fails in Jest because the dot is interpreted as a nested path — use bracket notation (`obj['google.com']`) instead

---

## Phase 8: E2E Tests (Tier 3 — Full HTTP Stack) — DONE (78 tests)
> Verify the complete request lifecycle. Requires Docker.

- [x] **8.1 — `test/e2e/auth.e2e-spec.ts`** — 9 tests
  - Register → Login → GET /me → Logout → GET /me returns null
  - Register duplicate email → 400
  - Login wrong password → 401 (same message as wrong email — no enumeration)
  - Rate limiting: 6th request within 60s → 429
  - CSRF: POST without Origin header (with session cookie) → 403
  - Change password → old sessions terminated
  - Username check → available / taken

- [x] **8.2 — `test/e2e/reviews.e2e-spec.ts`** — 5 tests
  - Create review (authenticated) → 201, appears in list with APPROVED status
  - Create review (unauthenticated) → 401
  - Create review (invalid body) → 400 with Zod error shape
  - List reviews: pagination, category filter, companyId filter
  - Vote UP → helpfulCount updates, vote again → toggles off
  - GET /reviews/:id → full review with comments

- [x] **8.3 — `test/e2e/complaints.e2e-spec.ts`** — 7 tests
  - Create complaint → appears in list
  - Vote with transaction-recount verified via GET
  - Admin reply (with X-Admin-Key) → 201, status transitions
  - Non-admin reply → 401

- [x] **8.4 — `test/e2e/comments.e2e-spec.ts`** — 11 tests
  - Create comment on review → comment count in review response updates
  - Create reply (parentId) → appears nested under parent
  - Vote on comment

- [x] **8.5 — `test/e2e/users.e2e-spec.ts`** — 25 tests
  - GET /users/:username → public profile
  - Follow/unfollow flow → follower count changes
  - Self-follow → 400
  - GET followers/following lists

- [x] **8.6 — `test/e2e/admin.e2e-spec.ts`** — 5 tests
  - Admin login → JWT in response
  - Stats with admin key → 200
  - Stats without admin key → 401
  - Update review status (PENDING → APPROVED)

- [x] **8.7 — `test/e2e/search-feed-trending.e2e-spec.ts`** — 8 tests
  - Search companies/reviews/users by query
  - Feed returns merged reviews + complaints sorted by date
  - Trending returns ranked results

- [x] **8.8 — `test/e2e/analytics.e2e-spec.ts`** — 8 tests
  - POST /track → 200 `{ ok: true }`
  - GET /health → public, returns status
  - GET /stats without key → 401
  - GET /stats with key → 200

> **Learnings:**
> - ThrottlerGuard persists rate-limit state in Redis across tests — must `flushTestRedis()` in `beforeEach`
> - Review create API returns object directly (not `{ review }`)
> - Users profile cache in Redis must be flushed before asserting follower counts

---

## Phase 9: Cleanup & CI — DONE
> Polish and enforcement

- [x] **9.1 — Migrate existing specs to shared helpers** — audited, shared helpers already used where appropriate
- [x] **9.2 — Add `.env.test` to repo** — committed in Phase 0
- [x] **9.3 — Add CI pipeline (`.github/workflows/test.yml`)** — 3 jobs: unit, integration-e2e, smoke
- [x] **9.4 — Add post-deploy smoke tests** — `test/smoke/smoke.spec.ts`, 5 read-only GETs
- [x] **9.5 — Update `specs/README.md`** ✅ Done

---

## Summary: Coverage Matrix

| Source File | Unit (Tier 1) | Integration (Tier 2) | E2E (Tier 3) | Phase |
|-------------|:---:|:---:|:---:|:---:|
| `auth/auth.guard.ts` | Phase 1 | — | Phase 8 | P0 |
| `auth/optional-auth.guard.ts` | Phase 1 | — | Phase 8 | P0 |
| `auth/auth.service.ts` | Phase 1 | Phase 7 | Phase 8 | P0 |
| `auth/auth.controller.ts` | Phase 1 | — | Phase 8 | P0 |
| `admin/admin.guard.ts` | Phase 1 | — | Phase 8 | P0 |
| `admin/admin-auth.service.ts` | Phase 1 | — | Phase 8 | P0 |
| `common/http-exception.filter.ts` | Phase 1 | — | Phase 8 | P0 |
| `reviews/reviews.service.ts` | Phase 2 | Phase 7 | Phase 8 | P1 |
| `complaints/complaints.service.ts` | Phase 2 | Phase 7 | Phase 8 | P1 |
| `comments/comments.service.ts` | Phase 2 | Phase 7 | Phase 8 | P1 |
| `users/users.service.ts` | Phase 3 | Phase 7 | Phase 8 | P2 |
| `notifications/notifications.service.ts` | Phase 3 | — | — | P2 |
| `notifications/push.service.ts` | Phase 3 | — | — | P2 |
| `feed/feed.service.ts` | Phase 3 | — | Phase 8 | P2 |
| `search/search.service.ts` | Phase 3 | — | Phase 8 | P2 |
| `trending/trending.service.ts` | Phase 3 | — | Phase 8 | P2 |
| `companies/companies.service.ts` | Phase 3 | — | — | P2 |
| `analytics/analytics.service.ts` | Phase 6 | Phase 7 | Phase 8 | P2 |
| `analytics/analytics.controller.ts` | Phase 6 | — | Phase 8 | P2 |
| `common/utils.ts` | Phase 4 | — | — | P4 |
| `config/config.service.ts` | Phase 4 | — | — | P4 |
| `config/env.schema.ts` | Phase 4 | — | — | P4 |
| `socket/socket.service.ts` | Phase 4 | — | — | P4 |
| `redis/redis.service.ts` | Phase 4 | — | — | P4 |
| `admin/admin.service.ts` | Phase 5 | — | Phase 8 | P3 |

**Not tested** (by design):
- `*.module.ts` — pure DI wiring
- `main.ts` — covered by e2e indirectly
- `api.controller.ts` / `data.service.ts` — dead code

**Actual totals:** 382 unit + 38 integration + 78 e2e = **498 tests** (382 run via `npm test`)

---

## Remaining Gaps (discovered during audit)

> Items below were identified by the verification audit. The loop should address these next.

- [x] **Fix 27 typecheck errors in test files** — `npx tsc --noEmit` shows errors in admin.service.spec, reviews/comments/complaints.service.spec (userVote type), and e2e tests (type assertions). Production code is clean.
- [x] **Fix lint errors in test files** — 556 problems (354 errors, 202 warnings), primarily `@typescript-eslint` strict-mode violations in test/e2e and test/helpers.
- [x] **Deepen analytics service tests (6.1)** — expanded from 16 to 49 tests. All private methods now tested: `normalizePath`, `sanitizeLabel`, `resolveCountry`, `normalizeIp`, `durationBucket`, `referrerLabel`, `bucketLongTail`, `parseFunnelMap`, `approximateDurationPercentile`.
- [x] **Deepen analytics controller tests (6.2)** — expanded from 13 to 23 tests. Added: `x-forwarded-for` with public IP selection, RFC 7239 `Forwarded:` header parsing, `x-real-ip`, `true-client-ip`, `fastly-client-ip`, private IP filtering, CDN country headers (`x-vercel-ip-country`, `cloudfront-viewer-country`), invalid country hint rejection.
- [x] **Complete push.service tests (3.3)** — expanded from 3 to 7 tests. Added: VAPID-configured init, send-to-all-subscriptions, stale subscription cleanup on 410 and 404. Uses `jest.mock('web-push')`.
- [ ] **Add admin-auth.controller login flow test (5.3)** — current tests only verify throttle metadata. Need: login delegation, config endpoint behavior.
- [ ] **Add admin.service cache TTL test (5.1)** — cache hit within TTL, eviction after TTL untested.
- [ ] **Add comments.service parentId reply notification test (2.3)** — the threaded reply notification path is untested.
