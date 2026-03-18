# Security Fixes Implementation Plan

> Generated from security audit on 2026-03-18. Addresses 10 verified universal backend vulnerabilities.
> This plan is consumed by `PROMPT.md` via the Ralph loop (`./loop.sh`).
> Tasks are ordered to minimize file conflicts. Execute top-to-bottom.

## Status Legend

- `[ ]` Pending
- `[x]` Complete
- `[!]` Blocked / needs attention

---

### [x] 1. Internal error messages leaked to clients

**Problem:** `errors.ts:handleError()` returns `error.message` for generic `Error` instances, leaking Prisma internals, connection strings, table names.

**Files to modify:**
- `src/common/errors.ts` — in the `if (error instanceof Error)` branch (lines ~64-69): log the real error with `console.error('[UnhandledError]', error.message, error.stack)`, then return `message: 'Internal server error'` (hardcoded, never the real message). Also add `console.error('[UnknownError]', error)` to the final fallback branch.

**Do NOT change:** ZodError branch (returns user-facing validation messages) or AppError branch (returns intentional messages).

**Verification:**
- `npm run lint` passes
- `npx tsc --noEmit` passes
- Write test: `src/common/errors.spec.ts` — verify handleError returns generic message for `new Error('Prisma: connection refused at 10.0.0.5:5432')`, preserves ZodError messages, preserves NotFoundError messages

---

### [ ] 2. Admin login endpoint has no dedicated rate limiting

**Problem:** `admin-auth.controller.ts` `POST /api/admin/auth/login` has no `@Throttle()` decorator, falls through to global limits (10/min). User auth endpoints correctly override to 5 req/60s.

**Files to modify:**
- `src/admin/admin-auth.controller.ts` — add `import { Throttle } from '@nestjs/throttler'` and add `@Throttle({ short: { limit: 5, ttl: 60_000 }, long: { limit: 5, ttl: 60_000 } })` decorator on the `login()` method. Do NOT throttle the `config()` endpoint.

**Verification:**
- `npm run lint` passes
- `npx tsc --noEmit` passes
- Write test: verify the decorator is present (can be a simple e2e test sending 6 requests)

---

### [ ] 3. Complaint reply authorization bypass

**Problem:** `POST /api/complaints/:id/reply` only requires `AuthGuard`. Any authenticated user can post company replies — the `req.user` is never passed to the service, no ownership check exists. There is no company-user ownership model in the schema.

**Decision:** Lock to admin-only now (AdminGuard). A proper company ownership model can be added later as a product feature.

**Files to modify:**
- `src/complaints/complaints.controller.ts` — change `@UseGuards(AuthGuard)` to `@UseGuards(AdminGuard)` on the `reply()` method (line ~76), add import
- `src/complaints/complaints.module.ts` — add `AdminGuard` to `providers` array (AdminGuard only injects ConfigService which is global, so no AdminModule import needed)

**Verification:**
- `npm run lint` passes
- `npx tsc --noEmit` passes
- Write test: `src/complaints/complaints.controller.spec.ts` — test that reply endpoint rejects regular user tokens and accepts admin key/JWT

---

### [ ] 4. Analytics API key grants admin access — separate keys completely

**Problem:** `admin.guard.ts:19` uses `process.env.ANALYTICS_API_KEY || process.env.ADMIN_API_KEY` — the analytics key grants full admin access. Also: admin key accepted via `?key=` query string (leaks in logs). Also: analytics endpoints are completely open when `ANALYTICS_API_KEY` is unset.

**Files to modify:**
- `src/admin/admin.guard.ts` — change `getApiKey()` to use ONLY `process.env.ADMIN_API_KEY`. Remove the query string (`?key=`) code path entirely. Only accept key via `X-Admin-Key` header.
- `src/analytics/analytics.controller.ts` — remove inline `apiKey` checks from `stats()`, `realtime()`, `latestMembers()`. Add `@UseGuards(AnalyticsGuard)` to those three methods. Remove `@Query('key')` params.
- `.env.example` — update comments to clarify key separation and new header name

**New file:**
- `src/analytics/analytics.guard.ts` — new guard that: reads `ANALYTICS_API_KEY` from env, accepts key via `X-Analytics-Key` header only (no query string), returns 401 when key is unset (fail-closed, not fail-open)

**Verification:**
- `npm run lint` passes
- `npx tsc --noEmit` passes
- Write test: `src/admin/admin.guard.spec.ts` — verify ANALYTICS_API_KEY no longer passes AdminGuard, query string rejected
- Write test: `src/analytics/analytics.guard.spec.ts` — verify guard rejects when key unset, rejects wrong key, accepts correct key via header

---

### [ ] 5. `helpful()` race condition — non-transactional vote count

**Problem:** `reviews.service.ts:helpful()` (lines ~303-342) uses `{ increment: 1 }` / `{ decrement: 1 }` outside a transaction. The `vote()` method on the same file correctly uses `$transaction` with recount. This violates CLAUDE.md constraint.

**Files to modify:**
- `src/reviews/reviews.service.ts` — rewrite `helpful()` to wrap all operations in `this.prisma.$transaction(async (tx) => { ... })`. Inside the transaction: find review, find existing vote, create/delete vote, then recount with `tx.helpfulVote.count()` for both UP and DOWN. Update review with recounted values. Emit socket events AFTER the transaction (not inside).

**Pattern to follow:** Copy the exact structure from `vote()` method in the same file (lines ~217-301).

**Verification:**
- `npm run lint` passes
- `npx tsc --noEmit` passes
- Write test: `src/reviews/reviews.service.spec.ts` — verify transaction is used, recount pattern is followed

---

### [ ] 6. User queries fetch passwordHash unnecessarily

**Problem:** Multiple Prisma queries on the User model omit `select`, returning all columns including `passwordHash`. The hash is never sent to clients but lives in memory unnecessarily.

**Files to modify:**
- `src/admin/admin.service.ts` — `getUserDetail()` (line ~246): replace `include` with explicit `select` listing all needed fields (id, email, username, name, avatar, role, verified, reputation, createdAt, updatedAt, _count)
- `src/auth/auth.service.ts` — 5 methods need `select` clauses:
  1. `findUserByEmailOrUsername()` (line ~27): add `select: { id: true, email: true, username: true }`
  2. `isUsernameAvailable()` (line ~39): add `select: { id: true }`
  3. `findUserByEmail()` (line ~121): add `select` with id, email, username, role, avatar, verified, reputation, AND `passwordHash: true` (needed for login password comparison)
  4. `getUserById()` (line ~246): add `select: { id: true, passwordHash: true }` (needed for change-password comparison)
  5. `getSessionFromToken()` (line ~222): change `include: { user: true }` to `include: { user: { select: { id, email, username, role, avatar, bio, verified, reputation } } }`

**Important:** `findUserByEmail()` and `getUserById()` MUST include `passwordHash` because their callers use it for `comparePassword()`. All others must EXCLUDE it.

**Verification:**
- `npx tsc --noEmit` passes (TypeScript will catch any missing field access)
- `npm run lint` passes
- Write test: verify passwordHash is not present on return value of findUserByEmailOrUsername and getUserDetail

---

### [ ] 7. Password change does not invalidate other sessions

**Problem:** `auth.service.ts:updatePassword()` only updates the hash. Existing sessions (including attacker's stolen session) remain valid for up to 7 days.

**Files to modify:**
- `src/auth/auth.service.ts` — add `deleteOtherSessions(userId: string, exceptToken: string): Promise<number>` method that deletes all sessions for the user except the one matching `exceptToken`. Uses `prisma.session.deleteMany({ where: { userId, token: { not: exceptToken } } })`.
- `src/auth/auth.controller.ts` — in `changePassword()`: after `updatePassword()`, create a new session via `createSession()`, call `deleteOtherSessions()` with the new token, set new session cookie via `res.cookie()`. Add `@Res({ passthrough: true }) res: Response` parameter.

**Verification:**
- `npm run lint` passes
- `npx tsc --noEmit` passes
- Write test: `src/auth/auth.service.spec.ts` — test deleteOtherSessions deletes correct sessions, preserves the excluded one
- Write test: verify changePassword sets a new cookie and old tokens become invalid

---

### [ ] 8. No proxy trust configuration — throttler uses wrong IP

**Problem:** No `trust proxy` setting in main.ts. Behind a reverse proxy, `req.ip` returns the proxy IP. ThrottlerGuard rate-limits by `req.ip`, so all users share one bucket.

**Files to modify:**
- `src/config/env.schema.ts` — add `TRUST_PROXY: z.string().optional()` to the env schema
- `src/config/config.service.ts` — add `get trustProxy(): string | undefined` getter
- `src/main.ts` — after getting ConfigService, if `trustProxy` is set: get the Express instance via `app.getHttpAdapter().getInstance()` and call `expressApp.set('trust proxy', value)`. Handle `"true"` as boolean `true`, numeric strings as numbers, anything else as the raw string.
- `.env.example` — add documented `TRUST_PROXY` variable with platform-specific examples (Railway: `true`, AWS ALB: `1`, etc.)

**Verification:**
- `npm run lint` passes
- `npx tsc --noEmit` passes
- Without `TRUST_PROXY` set, behavior is unchanged (no regression)

---

### [ ] 9. In-memory throttle store — use Redis when available

**Problem:** `ThrottlerModule.forRoot([...])` uses default in-memory store. Counters reset on restart. In multi-instance deploys, each instance has separate counts.

**New file:**
- `src/redis/redis-throttler-storage.ts` — implements `ThrottlerStorage` interface from `@nestjs/throttler`. Uses a Lua script for atomic increment+TTL+block checking via `RedisService.getClient()`. Fails open (returns `totalHits: 0`) when Redis is unavailable, matching the project's graceful-degradation pattern.

**Files to modify:**
- `src/app.module.ts` — change `ThrottlerModule.forRoot([...])` to `ThrottlerModule.forRootAsync({ useFactory: (redis) => ({ throttlers: [...], storage: new RedisThrottlerStorage(redis) }), inject: [RedisService] })`. The array form MUST change to object form with `throttlers` key, because the `@nestjs/throttler` source only reads `storage` from the object form.

**Verification:**
- `npm run lint` passes
- `npx tsc --noEmit` passes
- `npm run test` passes
- Manually verify: with `REDIS_URL` set, throttle counters persist across restarts. Without `REDIS_URL`, falls back to fail-open (no rate limiting but app works).

---

### [ ] 10. Session tokens stored as plain JWTs — hash before storing

**Problem:** Raw JWTs stored in `Session.token` column. If DB is compromised, all sessions are immediately usable.

**Files to modify:**
- `src/auth/auth.service.ts` — add `import { createHash } from 'node:crypto'`. Add private method `hashToken(token: string): string` that returns `createHash('sha256').update(token).digest('hex')`. Modify three methods:
  1. `createSession()` — hash token before storing: `data: { userId, token: this.hashToken(token), expiresAt }`
  2. `getSessionFromToken()` — hash incoming token before lookup: `findUnique({ where: { token: this.hashToken(token) } })`
  3. `deleteSession()` — hash token before delete: `deleteMany({ where: { token: this.hashToken(token) } })`
  4. Also update `deleteOtherSessions()` (from task 7) to hash the exceptToken

**Migration:** Create a Prisma migration that deletes all existing sessions (`DELETE FROM "Session"`). Old raw JWTs will never match hashed lookups. All users will need to log in again. This is acceptable for the current project stage.

**Run:** `npx prisma migrate dev --name hash_session_tokens`

**Verification:**
- `npm run lint` passes
- `npx tsc --noEmit` passes
- `npm run test` passes
- Write test: verify that the stored token in DB is a 64-char hex string (SHA-256), not a JWT
