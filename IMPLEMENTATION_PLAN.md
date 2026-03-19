# Implementation Plan: Complete Test Coverage

> **Created:** 2026-03-19 | **Baseline:** 11.13% statements, 45 tests, 10 spec files
> **Current:** 75.73% statements, 335 tests, 33 spec files (post-revert)
> **Goal:** 85%+ statements, 80%+ branches/functions across all `src/` modules
> **Spec:** See `specs/testing-strategy.md` for conventions, patterns, and infrastructure

---

## Completed Phases

### Phase 0: Test Infrastructure Setup — DONE
All 9 helper files, jest configs, .env.test, TestContainers globalSetup with 3-phase validation gate.

### Phase 1: Security-Critical Unit Tests — DONE (90 tests)
auth.guard, optional-auth.guard, auth.service, auth.controller, admin.guard, admin-auth.service, http-exception.filter.

### Phase 2: Data Integrity Unit Tests — DONE (52 tests)
reviews.service (vote/helpful/create/list/getById), complaints.service, comments.service — all with transaction-recount verification.

### Phase 3: Core Business Logic Unit Tests — DONE (51 tests)
users.service, notifications.service, push.service, feed.service, search.service, trending.service, companies.service.

### Phase 4: Infrastructure Unit Tests — DONE (69 tests)
utils (Zod schemas + scoring), config.service, env.schema, socket.service, redis.service, prisma.service.

### Phase 5: Admin Module Unit Tests — DONE (31 tests)
admin.service (expanded), admin.controller, admin-auth.controller.

### Phase 6: Analytics Unit Tests — DONE (29 tests)
analytics.service, analytics.controller.

### Phase 7: Integration Tests — PARTIAL (17 tests)
auth-sessions, reviews-voting, follows, cascade-deletes.

### Phase 8: E2E Tests — DONE (78 tests)
All 8 suites: auth, reviews, complaints, comments, users, admin, search-feed-trending, analytics.

### Phase 9: CI & Cleanup — DONE
GitHub Actions pipeline, smoke tests, specs/README updated.

---

## Remaining Work (priority order)

### HIGH — Fix Test Quality Issues

- [ ] **Fix 27 typecheck errors in test files**
  - `admin.service.spec.ts`: `Object is of type 'unknown'` / `possibly null` on assertions
  - `reviews/comments/complaints.service.spec.ts`: `userVote` not in Prisma type
  - `test/e2e/*.e2e-spec.ts`: type assertion mismatches
  - Run `npx tsc --noEmit` to verify — all errors are in test files, production is clean

- [ ] **Fix lint errors in test files**
  - 556 problems (354 errors, 202 warnings) concentrated in test/e2e and test/helpers
  - Primarily `@typescript-eslint` strict-mode violations (`no-unsafe-assignment`, `no-unsafe-member-access`)
  - Run `npm run lint` to verify

### MEDIUM — Deepen Shallow Tests

- [ ] **Deepen analytics tests (Phase 6)**
  - Only 3/25+ Redis key patterns verified — need explicit key name assertions
  - Private methods untested: `normalizePath`, `sanitizeLabel`, `resolveCountry`, `normalizeIp`, `durationBucket`, `referrerLabel`, `bucketLongTail`, `parseFunnelMap`, `approximateDurationPercentile`
  - Controller IP extraction: only `socket.remoteAddress` + `cf-connecting-ip` tested — need `x-forwarded-for`, RFC 7239, `x-real-ip`, private IP filtering

- [ ] **Complete push.service tests (Phase 3.3)**
  - Missing 3/6 planned items: VAPID-configured init, send-to-all-subscriptions, stale subscription cleanup on 410/404
  - Requires mocking the `web-push` module

- [ ] **Add admin-auth.controller login flow test (Phase 5.3)**
  - Current tests only verify throttle decorator metadata
  - Need: login delegation to AdminAuthService, config endpoint returns loginEnabled

- [ ] **Add admin.service cache TTL test (Phase 5.1)**
  - Cache behavior (hit within TTL, eviction after TTL) is untested
  - Module-level Map cache with 30s TTL

### LOW — Complete Deferred Integration Tests

- [ ] **7.3 — `test/integration/complaints-voting.spec.ts`**
  - Deferred — patterns identical to reviews-voting

- [ ] **7.4 — `test/integration/comments-voting.spec.ts`**
  - Deferred

- [ ] **7.7 — `test/integration/analytics-tracking.spec.ts`**
  - Requires Redis container (started but unused in current integration tests)

### LOW — Close Coverage Gap (75.73% → 85%)

- [ ] **11 controllers at 0% coverage** — biggest drag on overall numbers
  - These are thin routing layers; e2e tests cover the HTTP path but jest coverage only counts unit test runs
  - Options: (a) add lightweight controller unit tests, or (b) combine unit + e2e coverage reports

---

## Reverted Scope Violations

The following 4 commits were reverted on 2026-03-19 because they added production features outside the testing scope:

- `4ac9312` feat(posts): add PostsModule — REVERTED
- `59d42f3` feat(reports): add ReportsModule — REVERTED
- `6a5d13f` feat(reactions): add ReactionsModule — REVERTED
- `f03348e` feat(companies): add company follow/unfollow — REVERTED (breaking API change)

These features may be re-implemented in a separate branch with proper review.

---

## Learnings

- `@types/nock` needed alongside nock v14
- Jest `globalSetup` runs in separate process — `globalThis` doesn't propagate to workers, use `process.env` fallback
- Feed service chunked merge-sort: mocks must use `mockResolvedValueOnce` then `[]`
- Admin caches are module-level — tests sharing cache keys hit stale data
- ThrottlerGuard persists rate-limit state in Redis across e2e tests — flush in `beforeEach`
- `PushSubscription` table was missing from migration — switched to dynamic table discovery in `truncateAll()`
- Review create API returns object directly (not `{ review }`)
- Redis mock needs `pfadd`, `pfcount`, `incrby`, `zremrangebyscore` for analytics
