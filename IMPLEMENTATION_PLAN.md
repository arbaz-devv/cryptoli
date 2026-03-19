# Implementation Plan: Complete Test Coverage

> **Created:** 2026-03-19 | **Baseline:** 11.13% statements, 45 tests, 10 spec files
> **Goal:** Complete unit, integration, and e2e test coverage across all `src/` modules
> **Spec:** See `specs/testing-strategy.md` for conventions, patterns, and infrastructure

---

## Phase 0: Test Infrastructure Setup
> Foundation that all other phases depend on. Nothing else can start until this is done.

- [ ] **0.1 — Install TestContainers and isolation dependencies**
  - `npm install -D testcontainers @testcontainers/postgresql nock`
  - `nock` blocks all outbound HTTP in integration/e2e tests (prevents `ipwho.is` calls, push notifications, etc.)
  - Verify Docker is available in dev environment

- [ ] **0.2 — Create `.env.test`**
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

- [ ] **0.3 — Create TestContainers global setup/teardown with three-phase boot sequence**
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

- [ ] **0.4 — Create shared unit test mock factories (`test/helpers/`)**
  - `prisma.mock.ts` — reusable PrismaService mock with `$transaction` callback unwrapping, per-model jest.fn() stubs
  - `redis.mock.ts` — RedisService mock with `isReady()` toggle
  - `socket.mock.ts` — SocketService mock with all 7 emit methods as `jest.fn()`
  - `auth.helpers.ts` — `createMockSessionUser()`, `createTestJwt()`, `mockRequest()`, `mockExecutionContext()`

- [ ] **0.5 — Create test data factory functions (`test/helpers/factories.ts`)**
  - `createTestUser(prisma, overrides)` — with bcrypt cost 1 for speed
  - `createTestCompany(prisma, overrides)`
  - `createTestReview(prisma, authorId, overrides)` — defaults to APPROVED
  - `createTestComplaint(prisma, authorId, overrides)`
  - `createTestComment(prisma, authorId, reviewId, overrides)`
  - Auto-incrementing counter for unique emails/slugs

- [ ] **0.6 — Create E2E app bootstrap helper (`test/helpers/setup-app.ts`)**
  - Replicates `main.ts` middleware: Helmet, CORS, CSRF, cookie-parser, ValidationPipe, AllExceptionsFilter
  - Boots real `AppModule` but **overrides PrismaService and RedisService** with explicitly-constructed test instances (from `getTestPrisma()` / `getTestRedisUrl()` — not from `process.env`)
  - `setupTestApp()` returns `{ app, server }`, `teardownTestApp(app)` calls `app.close()`
  - **The override is the primary isolation** — even if `.env` has production credentials, the overridden providers point to TestContainers

- [ ] **0.7 — Create jest config files**
  - `test/jest-integration.json` — `rootDir: "."`, `testRegex: "test/integration/.*\\.spec\\.ts$"`, `globalSetup/globalTeardown` pointing to TestContainers setup, timeout 30000ms
  - Update `test/jest-e2e.json` — same globalSetup/globalTeardown, `testRegex: "test/e2e/.*\\.e2e-spec\\.ts$"`, timeout 60000ms
  - Update `package.json` jest config — add `collectCoverageFrom` exclusions (`*.module.ts`, `main.ts`, `*.dto.ts`, `api.controller.ts`, `data.service.ts`), add `coverageThreshold` (80/80/85/85)

- [ ] **0.8 — Add npm scripts**
  - `test:integration` → `jest --config test/jest-integration.json`
  - `test:e2e` → `jest --config test/jest-e2e.json`
  - `test:all` → `npm test && npm run test:integration && npm run test:e2e`

---

## Phase 1: Security-Critical Unit Tests (P0)
> Auth, guards, session management — highest risk if broken. All mocked (Tier 1).

- [ ] **1.1 — `src/auth/auth.guard.spec.ts`** *(NEW — 27% lines)*
  - canActivate: returns true + sets `req.user` when session valid
  - canActivate: throws UnauthorizedException when no token
  - canActivate: throws UnauthorizedException when token expired/invalid
  - canActivate: throws UnauthorizedException when DB session missing
  - Token extraction: Bearer header > cookie > raw cookie header priority

- [ ] **1.2 — `src/auth/optional-auth.guard.spec.ts`** *(NEW — 33% lines)*
  - Always returns true (never blocks)
  - Sets `req.user` to SessionUser when session valid
  - Sets `req.user` to `null` (not `undefined`) when no session

- [ ] **1.3 — Expand `src/auth/auth.service.spec.ts`** *(existing — 29.67% lines)*
  - `createUser`: hashes password, returns profile without passwordHash
  - `hashPassword` / `comparePassword`: bcrypt round-trip
  - `createSession`: JWT payload contains `{ userId, jti }`, 7-day expiry
  - `getSessionFromToken`: rejects expired JWT, rejects valid JWT with deleted DB session
  - `getSessionTokenFromRequest`: Bearer > cookie > raw header priority chain
  - `updateProfile`: trims bio, converts empty to null
  - `generateUsernameSuggestions`: returns available candidates

- [ ] **1.4 — `src/auth/auth.controller.spec.ts`** *(NEW — 0%)*
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

- [ ] **1.5 — Expand `src/admin/admin.guard.spec.ts`** *(existing — 66.66% lines)*
  - JWT-based admin auth: valid admin JWT accepted
  - JWT-based admin auth: non-admin JWT rejected, expired JWT rejected
  - Missing/undefined/whitespace `ADMIN_API_KEY` behavior

- [ ] **1.6 — `src/admin/admin-auth.service.spec.ts`** *(NEW — 27% indirect)*
  - `isLoginEnabled`: true when both email + hash configured, false when either missing
  - `login`: returns JWT with `type: 'admin'` claim, 24h expiry
  - `login`: throws UnauthorizedException for wrong email/password/unconfigured

- [ ] **1.7 — `src/common/http-exception.filter.spec.ts`** *(NEW — 0%)*
  - HttpException: extracts status + message
  - HttpException with errors array: passes through
  - Non-HttpException: delegates to `handleError()`, returns sanitized 500
  - Response shape: `{ error }` or `{ error, errors }`

---

## Phase 2: Data Integrity Unit Tests (P1)
> Voting, transactions, recounts — data corruption risk. All mocked (Tier 1).

- [ ] **2.1 — Expand `src/reviews/reviews.service.spec.ts`** *(existing — 36.92% lines)*
  - `vote()`: all toggle logic (new/same/opposite), recount with `count()`, notification conditions, socket emit ordering, invalid voteType rejection
  - `create()`: Zod validation, auto-approve, score computation, socket emit
  - `list()`: pagination, filters, APPROVED-only, userVote enrichment
  - `getById()`: NotFoundError, includes comments

- [ ] **2.2 — `src/complaints/complaints.service.spec.ts`** *(NEW — 7.69% lines)*
  - `vote()`: full transaction-recount, toggle logic, invalid voteType
  - `create()`: Zod validation, status OPEN
  - `list()`: pagination, userVote enrichment
  - `getById()`: NotFoundError, userVote
  - `reply()`: Zod validation, OPEN→IN_PROGRESS transition, missing complaint/company errors

- [ ] **2.3 — `src/comments/comments.service.spec.ts`** *(NEW — 0%)*
  - `vote()`: transaction-recount, toggle logic, notification conditions
  - `create()`: Zod validation, exactly-one-target enforcement, socket emit (review only), notifications
  - `list()`: top-level + nested replies, userVote enrichment
  - `getById()`: `id === 'list'` fallback

---

## Phase 3: Core Business Logic Unit Tests (P2)
> Complex services. All mocked (Tier 1).

- [ ] **3.1 — `src/users/users.service.spec.ts`** *(NEW — 0%)*
  - `getPublicProfile()`: cache hit/miss, Redis failure fallback, viewerState never cached
  - `followUser()`: creates Follow, self-follow rejection, duplicate idempotent, cache invalidation
  - `unfollowUser()`: deletes Follow, self-unfollow rejection, cache invalidation
  - `getFollowStatusBulk()`: deduplication, cap at 50, excludes self

- [ ] **3.2 — `src/notifications/notifications.service.spec.ts`** *(NEW — 19% lines)*
  - `createForUser()`: DB record + socket emit + push (push error swallowed)
  - `listForUser()`: last 25 + unreadCount
  - `markRead()`: ownership check, socket emit
  - `markAllRead()`: bulk update + socket emit

- [ ] **3.3 — `src/notifications/push.service.spec.ts`** *(NEW — 18% lines)*
  - `onModuleInit()`: VAPID configured/not-configured
  - `registerSubscription()`: upserts by endpoint
  - `sendToUser()`: no-op when VAPID absent, sends to all, auto-deletes stale on 410/404

- [ ] **3.4 — `src/feed/feed.service.spec.ts`** *(NEW — 0%)*
  - `getFeed()`: merges reviews + complaints by createdAt desc, APPROVED filter, type discriminator, pagination, empty results

- [ ] **3.5 — `src/search/search.service.spec.ts`** *(NEW — 0%)*
  - `search()`: empty query, per-entity search, type filter, limit

- [ ] **3.6 — `src/trending/trending.service.spec.ts`** *(NEW — 0%)*
  - `getTrending()`: period handling, ordering, field mapping

- [ ] **3.7 — `src/companies/companies.service.spec.ts`** *(NEW — 0%)*
  - `list()`: pagination, category/search filters
  - `getBySlug()`: averageScore, NotFoundError

---

## Phase 4: Infrastructure Unit Tests (P4)
> Redis, Socket, Config, Utilities. All mocked (Tier 1).

- [ ] **4.1 — `src/common/utils.spec.ts`** *(NEW — 56.52% indirect)*
  - `hashPassword` / `verifyPassword` round-trip
  - `calculateOverallScore()`: known weights, unknown keys
  - All 8 Zod schemas: valid passes, invalid rejects with correct messages

- [ ] **4.2 — `src/config/config.service.spec.ts`** *(NEW — 14% lines)*
  - Getter correctness, `jwtSecret` production guard, `isProduction`

- [ ] **4.3 — `src/config/env.schema.spec.ts`** *(NEW — 23% lines)*
  - `validateEnv()`: valid/invalid env, defaults

- [ ] **4.4 — `src/socket/socket.service.spec.ts`** *(NEW — 8% lines)*
  - All 7 emit methods: no-op when undefined, correct room + event name when defined

- [ ] **4.5 — `src/redis/redis.service.spec.ts`** *(NEW — 0%)*
  - `onModuleInit()`: client creation / no-op, `isReady()`, `onModuleDestroy()`

- [ ] **4.6 — `src/prisma/prisma.service.spec.ts`** *(NEW — 60% indirect)*
  - `onModuleDestroy()`: calls `$disconnect`

---

## Phase 5: Admin Module Unit Tests (P3)
> Admin business logic. All mocked (Tier 1).

- [ ] **5.1 — Expand `src/admin/admin.service.spec.ts`** *(existing — 9.87% lines)*
  - `getStats()`, `getUsers()`, `getUserDetail(lazy/full)`, `getReview(lazy/full)`, `getReviews()`, `updateReviewStatus()`, `getRatings()`, cache TTL behavior

- [ ] **5.2 — `src/admin/admin.controller.spec.ts`** *(NEW — 0%)*
  - AdminGuard on all endpoints, pagination clamping, delegation to service

- [ ] **5.3 — Expand `src/admin/admin-auth.controller.spec.ts`** *(existing)*
  - Login flow (valid/invalid credentials), config endpoint

---

## Phase 6: Analytics Unit Tests (P2)
> Most complex module — 1098 lines, 25+ Redis keys. All mocked (Tier 1).

- [ ] **6.1 — `src/analytics/analytics.service.spec.ts`** *(NEW — 0%)*
  - `track()`: no-op when Redis not ready or consent false
  - `track()`: page_view/like/funnel/page_leave write correct Redis keys
  - `getStats()`: emptyStats fallback, 1-minute cache, date range aggregation
  - `getRealtime()`: active sessions from last 5 minutes
  - `resolveCountry()`: CDN hint > cache > geoip > external API priority
  - `normalizePath()`, `sanitizeLabel()`: transformation correctness
  - `isHealthy()`: PING check

- [ ] **6.2 — `src/analytics/analytics.controller.spec.ts`** *(NEW — 0%)*
  - IP extraction priority chain, guard requirements per endpoint
  - Helper functions: normalizeIp, isPrivateOrLocalIp, pickBestIp, getClientIp, getCountryHint

---

## Phase 7: Integration Tests (Tier 2 — Real Database)
> Verify that Prisma queries, transactions, and constraints actually work. Requires Docker.

- [ ] **7.1 — `test/integration/auth-sessions.spec.ts`**
  - Create session → lookup by hashed token → found
  - Create session → delete → lookup → not found
  - Delete other sessions → only current session survives
  - Session expiry → lookup returns null
  - User deletion cascades to sessions

- [ ] **7.2 — `test/integration/reviews-voting.spec.ts`**
  - Vote UP → helpfulCount is 1 in DB
  - Vote UP then UP again → vote deleted, helpfulCount is 0
  - Vote UP then DOWN → switches, counts correct
  - Concurrent votes from different users → counts still accurate (no drift)
  - @@unique(userId, reviewId) rejects duplicate via direct Prisma (bypassing service toggle)

- [ ] **7.3 — `test/integration/complaints-voting.spec.ts`**
  - Same patterns as reviews-voting but on ComplaintVote
  - Reply creates ComplaintReply record
  - Reply transitions complaint status OPEN → IN_PROGRESS

- [ ] **7.4 — `test/integration/comments-voting.spec.ts`**
  - CommentVote transaction-recount
  - Comment creation with parentId creates threaded reply
  - Comment on review updates actual comment count

- [ ] **7.5 — `test/integration/follows.spec.ts`**
  - Follow creates record, unfollow deletes
  - Self-follow rejected
  - @@unique(followerId, followingId) prevents duplicate
  - User deletion cascades Follow records
  - CompanyFollow same patterns

- [ ] **7.6 — `test/integration/cascade-deletes.spec.ts`**
  - Delete User → verify 14+ dependent tables are empty
  - Delete Company → Products, Reviews, CompanyFollows, Complaints, ComplaintReplies gone
  - Delete Review → Comments, HelpfulVotes, Reactions, Media gone
  - Delete Comment → child Comments, CommentVotes, Reactions gone

- [ ] **7.7 — `test/integration/analytics-tracking.spec.ts`** *(requires Redis container)*
  - `track()` page_view → Redis keys exist with correct values
  - `getStats()` → aggregated data matches what was tracked
  - `getRealtime()` → active sessions reflect recent tracks
  - Redis unavailable → graceful no-op (stop Redis container mid-test)

---

## Phase 8: E2E Tests (Tier 3 — Full HTTP Stack)
> Verify the complete request lifecycle. Requires Docker.

- [ ] **8.1 — `test/e2e/auth.e2e-spec.ts`**
  - Register → Login → GET /me → Logout → GET /me returns null
  - Register duplicate email → 400
  - Login wrong password → 401 (same message as wrong email — no enumeration)
  - Rate limiting: 6th request within 60s → 429
  - CSRF: POST without Origin header (with session cookie) → 403
  - Change password → old sessions terminated
  - Username check → available / taken

- [ ] **8.2 — `test/e2e/reviews.e2e-spec.ts`**
  - Create review (authenticated) → 201, appears in list with APPROVED status
  - Create review (unauthenticated) → 401
  - Create review (invalid body) → 400 with Zod error shape
  - List reviews: pagination, category filter, companyId filter
  - Vote UP → helpfulCount updates, vote again → toggles off
  - GET /reviews/:id → full review with comments

- [ ] **8.3 — `test/e2e/complaints.e2e-spec.ts`**
  - Create complaint → appears in list
  - Vote with transaction-recount verified via GET
  - Admin reply (with X-Admin-Key) → 201, status transitions
  - Non-admin reply → 401

- [ ] **8.4 — `test/e2e/comments.e2e-spec.ts`**
  - Create comment on review → comment count in review response updates
  - Create reply (parentId) → appears nested under parent
  - Vote on comment

- [ ] **8.5 — `test/e2e/users.e2e-spec.ts`**
  - GET /users/:username → public profile
  - Follow/unfollow flow → follower count changes
  - Self-follow → 400
  - GET followers/following lists

- [ ] **8.6 — `test/e2e/admin.e2e-spec.ts`**
  - Admin login → JWT in response
  - Stats with admin key → 200
  - Stats without admin key → 401
  - Update review status (PENDING → APPROVED)

- [ ] **8.7 — `test/e2e/search-feed-trending.e2e-spec.ts`**
  - Search companies/reviews/users by query
  - Feed returns merged reviews + complaints sorted by date
  - Trending returns ranked reviews

- [ ] **8.8 — `test/e2e/analytics.e2e-spec.ts`**
  - POST /track → 200 `{ ok: true }`
  - GET /health → public, returns status
  - GET /stats without key → 401
  - GET /stats with key → 200

---

## Phase 9: Cleanup & CI
> Polish and enforcement

- [ ] **9.1 — Migrate existing specs to shared helpers**
  - Refactor 10 existing spec files to use `test/helpers/` mock factories
  - Ensure consistent patterns across all tests

- [ ] **9.2 — Add `.env.test` to repo** (commit only test-safe values)

- [ ] **9.3 — Add CI pipeline (`.github/workflows/test.yml`)**
  - Unit tests: no Docker needed, runs `npm test`
  - Integration + E2E: requires Docker, runs `npm run test:integration && npm run test:e2e`
  - Coverage gate: `npm run test:cov` must pass 80/80/85/85 threshold

- [ ] **9.4 — Add post-deploy smoke tests**
  - `test/smoke/smoke.spec.ts` — runs against a live URL (`SMOKE_TEST_URL` env var)
  - 5 read-only requests, no test data, no side effects, ~2 seconds total:
    - `GET /` → 200 (app alive)
    - `GET /api/analytics/health` → 200 (Redis connected)
    - `GET /api/auth/me` → 200 (auth middleware + DB working)
    - `GET /api/reviews?limit=1` → 200 (Prisma queries working)
    - `GET /api/companies?limit=1` → 200 (second table accessible)
  - npm script: `test:smoke` → `SMOKE_TEST_URL=https://... jest --config test/jest-smoke.json`
  - Wire into CI as a post-deploy step (runs after Railway deploy succeeds)

- [ ] **9.5 — Update `specs/README.md`**
  - ~~Add testing-strategy.md to the spec index~~ ✅ Done

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

**Estimated totals:** ~250 unit tests + ~50 integration tests + ~50 e2e tests = ~350 tests
