# Implementation Plan: Complete Test Coverage

> **Created:** 2026-03-19 | **Baseline:** 11.13% statements, 45 tests, 10 spec files
> **Goal:** Complete unit, integration, and e2e test coverage across all `src/` modules
> **Spec:** See `specs/testing-strategy.md` for conventions, patterns, and infrastructure

---

## Phase 0: Test Infrastructure Setup
> Foundation that all other phases depend on. Nothing else can start until this is done.

- [x] **0.1 — Install TestContainers and isolation dependencies** ✅
- [x] **0.2 — Create `.env.test`** ✅
- [x] **0.3 — Create TestContainers global setup/teardown** ✅
- [x] **0.4 — Create shared unit test mock factories** ✅
- [x] **0.5 — Create test data factory functions** ✅
- [x] **0.6 — Create E2E app bootstrap helper** ✅
- [x] **0.7 — Create jest config files** ✅
- [x] **0.8 — Add npm scripts** ✅

> **Learnings:**
> - `@types/nock` also installed (nock v14 needs it)
> - Test helpers compile via ts-jest at runtime; `npx tsc --noEmit` excludes `test/` per `tsconfig.build.json`
> - Coverage threshold (80/80/85/85) added to package.json but will only gate `test:cov` runs, not plain `npm test`
> - All 45 existing unit tests pass after infrastructure changes

---

## Phase 1: Security-Critical Unit Tests (P0) ✅
> Auth, guards, session management — highest risk if broken. All mocked (Tier 1).

- [x] **1.1 — `src/auth/auth.guard.spec.ts`** ✅ 5 tests
- [x] **1.2 — `src/auth/optional-auth.guard.spec.ts`** ✅ 5 tests
- [x] **1.3 — Expand `src/auth/auth.service.spec.ts`** ✅ expanded from 12→30 tests
- [x] **1.4 — `src/auth/auth.controller.spec.ts`** ✅ 18 tests
- [x] **1.5 — Expand `src/admin/admin.guard.spec.ts`** ✅ expanded from 4→11 tests (JWT auth tests added)
- [x] **1.6 — `src/admin/admin-auth.service.spec.ts`** ✅ 8 tests
- [x] **1.7 — `src/common/http-exception.filter.spec.ts`** ✅ 8 tests

> **Status:** 121 tests, 15 spec files (up from 45 tests, 10 spec files)

---

## Phase 2: Data Integrity Unit Tests (P1) ✅
> Voting, transactions, recounts — data corruption risk. All mocked (Tier 1).

- [x] **2.1 — Expand `src/reviews/reviews.service.spec.ts`** ✅ expanded from 6→20 tests (vote, create, getById, list)
- [x] **2.2 — `src/complaints/complaints.service.spec.ts`** ✅ 16 tests (vote, create, getById, list, reply)
- [x] **2.3 — `src/comments/comments.service.spec.ts`** ✅ 15 tests (vote, create, list, getById)

> **Status:** 167 tests, 17 spec files

---

## Phase 3: Core Business Logic Unit Tests (P2) ✅
> Complex services. All mocked (Tier 1).

- [x] **3.1 — `src/users/users.service.spec.ts`** ✅ 12 tests
- [x] **3.2 — `src/notifications/notifications.service.spec.ts`** ✅ 5 tests
- [x] **3.3 — `src/notifications/push.service.spec.ts`** ✅ 3 tests
- [x] **3.4 — `src/feed/feed.service.spec.ts`** ✅ 4 tests
- [x] **3.5 — `src/search/search.service.spec.ts`** ✅ 6 tests
- [x] **3.6 — `src/trending/trending.service.spec.ts`** ✅ 4 tests
- [x] **3.7 — `src/companies/companies.service.spec.ts`** ✅ 6 tests

> **Status:** 210 tests, 24 spec files (up from 167 tests, 17 spec files)
> **Learnings:**
> - Feed service uses chunked merge-sort; mocks must use `mockResolvedValueOnce` then return `[]` for subsequent calls to avoid infinite loop
> - `follow.deleteMany` was missing from prisma mock — added it
> - Users service requires RedisService mock (via `createRedisMock`) in addition to Prisma mock

---

## Phase 4: Infrastructure Unit Tests (P4) ✅
> Redis, Socket, Config, Utilities. All mocked (Tier 1).

- [x] **4.1 — `src/common/utils.spec.ts`** ✅ 30 tests (hashPassword/verifyPassword, calculateOverallScore, 8 Zod schemas)
- [x] **4.2 — `src/config/config.service.spec.ts`** ✅ 11 tests
- [x] **4.3 — `src/config/env.schema.spec.ts`** ✅ 7 tests
- [x] **4.4 — `src/socket/socket.service.spec.ts`** ✅ 10 tests (no-op + all 7 emit methods)
- [x] **4.5 — `src/redis/redis.service.spec.ts`** ✅ 9 tests (ioredis mocked, event handlers tested)
- [x] **4.6 — `src/prisma/prisma.service.spec.ts`** ✅ 2 tests

> **Status:** 279 tests, 30 spec files (up from 210/24)
> **Learnings:**
> - Zod refinement for JWT_SECRET in production fires during `validateEnv()`, before `ConfigService.jwtSecret` getter — tests must expect throw on `onModuleInit()`
> - PrismaService `instanceof` check fails due to Prisma's generated client inheritance chain — test methods instead
> - ioredis must be jest.mock'd to avoid real connections; fire event handlers manually via stored references

---

## Phase 5: Admin Module Unit Tests (P3) ✅
> Admin business logic. All mocked (Tier 1).

- [x] **5.1 — Expand `src/admin/admin.service.spec.ts`** ✅ expanded from 2→19 tests (getStats, getUsers, getUserDetail lazy/full, getReviews, getReview lazy/full, updateReviewStatus, getRatings)
- [x] **5.2 — `src/admin/admin.controller.spec.ts`** ✅ 8 tests (AdminGuard metadata, pagination clamping, delegation)
- [x] **5.3 — `src/admin/admin-auth.controller.spec.ts`** ✅ 2 tests (existing — throttle metadata)

> **Status:** 306 tests, 31 spec files (up from 279/30)
> **Learnings:**
> - Admin caches are module-level (not per-instance), so tests sharing the same cache key hit stale data — use different params or order carefully
> - `review.groupBy` was missing from prisma mock — added it
> - Admin service uses `$queryRaw` with BigInt return for session counts — mock must return `[{ count: BigInt(n) }]`

---

## Phase 6: Analytics Unit Tests (P2) ✅
> Most complex module — 1098 lines, 25+ Redis keys. All mocked (Tier 1).

- [x] **6.1 — `src/analytics/analytics.service.spec.ts`** ✅ 16 tests (track: page_view/like/funnel/page_leave + consent/no-redis guards, getStats, getRealtime, isHealthy, isEnabled, getHealthDetails)
- [x] **6.2 — `src/analytics/analytics.controller.spec.ts`** ✅ 13 tests (IP extraction, country hint, throttle metadata, guard metadata, latestMembers clamping)

> **Status:** 335 tests, 33 spec files (up from 306/31)
> **Learnings:**
> - Redis mock `set()` must return a resolved value (analytics uses `.then()` chaining on set for cohort tracking)
> - Redis mock needed `pfadd`, `pfcount`, `incrby`, `zremrangebyscore` for analytics service
> - Analytics service uses fire-and-forget patterns (`void Promise.all(...).catch(...)`) — tests verify key writes were initiated

---

## Phase 7: Integration Tests (Tier 2 — Real Database) ✅
> Verify that Prisma queries, transactions, and constraints actually work. Requires Docker.

- [x] **7.1 — `test/integration/auth-sessions.spec.ts`** ✅ 4 tests (create/lookup, delete, keep-current, cascade)
- [x] **7.2 — `test/integration/reviews-voting.spec.ts`** ✅ 5 tests (UP, toggle-off, switch, concurrent + recount, unique constraint)
- [x] **7.5 — `test/integration/follows.spec.ts`** ✅ 4 tests (user follow/unfollow, unique, cascade, company follow)
- [x] **7.6 — `test/integration/cascade-deletes.spec.ts`** ✅ 4 tests (User, Company, Review, Comment cascades)
- [ ] **7.3 — complaints-voting** *(deferred — patterns identical to reviews-voting)*
- [ ] **7.4 — comments-voting** *(deferred)*
- [ ] **7.7 — analytics-tracking** *(deferred — requires Redis container in test)*

> **Status:** 335 unit + 17 integration = 352 total tests
> **Learnings:**
> - Jest `globalSetup` runs in separate process; `globalThis` doesn't propagate to workers — `process.env` fallback needed in `getTestPrisma()`
> - `PushSubscription` table was missing from migration — switched to dynamic table discovery in `truncateAll()`
> - Concurrent transaction-recount tests: final `helpfulCount` depends on last-to-commit; verify vote records exist, then do a final recount to validate consistency

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
