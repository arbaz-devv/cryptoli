# Analytics Phase 2: Gap Analysis & Implementation Roadmap

> **Date:** 2026-03-30
> **Baseline:** main branches across 3 repos — cryptoli (fa1d85b), cryptoi-admin (5578a61), cryptoli-frontend (be97f28)
> **Method:** 20 specialized Opus agents audited all 3 codebases, verifying every claim against actual code with file:line evidence. 875 tool invocations, ~50 min cumulative runtime.
> **Scope:** Security gaps, GDPR compliance, admin dashboard underutilization.

---

## Table of Contents

1. [The Core Problem](#1-the-core-problem)
2. [Security Findings](#2-security-findings) (S1–S3)
3. [GDPR Findings](#3-gdpr-findings) (G1–G5)
4. [Admin Underutilization Findings](#4-admin-underutilization-findings) (A1–A2)
5. [Data Flow Disconnects](#5-data-flow-disconnects) (D1–D2)
6. [Implementation Roadmap](#6-implementation-roadmap)
7. [Test Gaps to Address During Implementation](#7-test-gaps-to-address-during-implementation)

---

## 1. The Core Problem

The analytics platform is a **fully operational write machine with a severely underbuilt read layer**.

| Storage | Write Path | Read Path | Utilization |
|---------|-----------|-----------|-------------|
| Redis counters (22+ key patterns per day) | `track()` page_view/page_leave/like/funnel | `getStats()`, `getRealtime()` | **Well-utilized** |
| `analytics_daily_summaries` (EAV, ~300 rows/day) | Rollup service | `getStats()` historical range | **Well-utilized** |
| `analytics_events` (17 cols, ~13M rows/month) | Buffer service flush every 2s | **Zero user-facing reads** | **Complete waste — ~76 GB/year** |
| Server-side events (14 types, 7 modules) | `track()` → PG buffer only (no Redis) | **No endpoint queries this data** | **Complete waste** |
| Session enrichment (9 fields) | `createSession()` | Admin user detail, session list, export | **Well-utilized** |

---

## 2. Security Findings

### S1. IP Privacy Overhaul

**Priority: Critical** | Files: `analytics.service.ts`, `auth.service.ts`, `prisma/schema.prisma`

`hashIp()` at `analytics.service.ts:426-429` computes `SHA-256(raw_ip)` with no salt and no
truncation. The entire IPv4 space (~4.3B addresses) can be brute-forced in under 1 second on a
consumer GPU. A precomputed lookup table fits in ~200 GB.

**Full IP lifecycle (verified across all call sites):**

| Location | Format | Retention | Written by | Read by |
|----------|--------|-----------|------------|---------|
| `analytics_events.ip_hash` | SHA-256, unsalted | Permanent (GDPR anon only nulls `user_id`) | 5 call sites in `track()` | **Zero queries** |
| `Session.ip` | **Plaintext** | Permanent (no cleanup) | `auth.service.ts:255` | `admin.service.ts:559` (`lastLoginIp`), `admin.service.ts:560` (`registrationIp` fallback) |
| `Session.ipHash` | SHA-256, unsalted | Permanent (no cleanup) | `auth.service.ts:256-258` (independent duplicate, NOT calling `hashIp()`) | `admin.service.ts:1226` (getUserSessions), `admin.service.ts:1269` (export) — **display-only** |
| `User.registrationIp` | **Plaintext** | Permanent | `auth.controller.ts:267` | `admin.service.ts:560` |
| `analytics:ip_country:{ip}` | **Plaintext in key** | 30-day TTL | `analytics.service.ts:399` | Same location (cache lookup) |

**Key finding:** `analytics_events.ip_hash` is written but **never read** by any query anywhere in
the codebase. The rollup reads from Redis. The stats endpoint reads Redis + daily summaries. No
code filters, groups, or joins on this column.

**Inconsistency found:** `getUserDetail()` exposes raw plaintext IPs (`lastLoginIp`,
`registrationIp`) at `admin.service.ts:559-560`, while `getUserSessions()` deliberately strips raw
IP and only returns `ipHash` at `admin.service.ts:1224-1235`. The export test at
`admin.service.spec.ts:850` explicitly verifies "should exclude raw IP from export (hash only)."

**Fix — Option B+D (validated safe):**

1. **Option D:** Stop writing `ipHash` to `analytics_events` — remove from all 5 `pushToBuffer()`
   calls. Zero readers confirmed. Zero functional impact.
2. **Option B:** Upgrade `hashIp()` to `HMAC-SHA256(IP_HASH_SALT, ip)`. Add `IP_HASH_SALT` env
   var. Update the independent duplicate at `auth.service.ts:256-258` to use the same function.
3. **Redis cache key:** Hash the IP in `analytics:ip_country:{ip}` key at `analytics.service.ts:399`.
   One-line change. Coordinates cleanly with hashIp() upgrade. Cache misses during transition are
   benign (fall through to GeoIP lookup, ~30 day cold window).
4. Admin impact: Session.ipHash is display-only (never compared, joined, or filtered). Old sessions
   keep old hashes, new sessions get HMAC hashes. Column stays `Char(64)` — no migration needed.

**Tests requiring update:** `analytics.service.spec.ts:1213-1232` (deterministic hash),
`auth.service.spec.ts:145`, `test/e2e/admin.e2e-spec.ts:51,66,192,255`,
`test/integration/analytics-buffer.spec.ts:41`.

---

### S2. Health Endpoint Information Disclosure

**Priority: Medium** | File: `analytics.controller.ts:73-89`

`GET /api/analytics/health` has **no auth guard** while every other analytics read endpoint uses
`@UseGuards(AnalyticsGuard)`. Response leaks:

| Field | Source | Risk |
|-------|--------|------|
| `configured` | `Boolean(process.env.REDIS_URL?.trim())` | Reveals env var state |
| `connected` | `redisService.isReady()` | Reveals infra state |
| `lastError` | `redisService.getLastError()` (`redis.service.ts:22-25`) | **Raw ioredis errors: internal hostnames, ports, auth errors** |
| `rollup.lastSuccessDate` | Redis key `analytics:rollup:last_success` | Operational cadence |
| `rollup.stale` | 48-hour threshold comparison | Degradation state |

**Breaking change:** The admin dashboard's `checkAnalyticsHealth()` at
`cryptoi-admin/lib/analytics.ts:104-141` calls this endpoint with **NO authentication headers**.
Adding a guard will cause the dashboard to show "Analytics not configured" permanently.

**Fix:** Resolved by Phase B proxy — admin calls go through `/api/admin/analytics/health` with
AdminGuard. The direct `/api/analytics/health` endpoint then gets `@UseGuards(AnalyticsGuard)`.

---

### S3. Error Leakage in latest-members

**Priority: Low** | File: `analytics.controller.ts:142-146`

Returns raw `e.message` to API caller. Only such pattern across all controllers. The analytics
controller has **no Logger instance** — one must be added.

**Fix:**
```typescript
private readonly logger = new Logger(AnalyticsController.name);
// In catch block:
this.logger.error('Failed to fetch latest members', e instanceof Error ? e.stack : String(e));
return { ok: false, error: 'Failed to fetch latest members' };
```

---

## 3. GDPR Findings

### G1. Right to Erasure Completely Unimplemented

**Priority: Critical**

`anonymizeUserAnalytics()` at `analytics.service.ts:1469` exists but is **never called by any
code**. Zero call sites in production. No account deletion endpoint exists anywhere in the codebase.
GDPR Article 17 (right to erasure) has zero implementation.

The method itself only nullifies `user_id`, not `ip_hash` or `session_id`.

---

### G2. 90-Day Anonymization Is Incomplete

**Priority: High** | File: `analytics.service.ts:1515`

`anonymizeExpiredUsers()` runs hourly with a Redis daily guard and concurrency lock (correct). But
it only nullifies `user_id`:

```sql
UPDATE analytics_events SET user_id = NULL WHERE user_id IS NOT NULL AND created_at < $cutoff
```

After "anonymization," each row **permanently retains**: `ip_hash` (trivially reversible SHA-256),
`session_id`, `country`, `device`, `browser`, `os`, `timezone`, `path`, `referrer`. The combination
of ipHash + sessionId + device fingerprint can re-identify individuals. Under GDPR, pseudonymous
data remains personal data.

If S1 Option D is implemented (stop writing ipHash), this gap is partially mitigated for new rows.
Existing rows with ipHash need a backfill UPDATE to null the column.

---

### G3. Server-Side Events Bypass Consent

**Priority: High**

All 11 server-side event call sites hardcode `consent: true`:
- `auth.controller.ts:74` (login, register, logout, password_change)
- `reviews.service.ts:174,338,421` (review_created, vote_cast)
- `comments.service.ts:385,600` (comment_created, vote_cast)
- `complaints.service.ts:171,338` (complaint_created, vote_cast)
- `users.service.ts:161,204` (user_follow, user_unfollow)
- `search.service.ts:103` (search_performed)

A user who explicitly declined analytics cookies will still have their reviews, comments, votes,
searches, follows, and logins recorded in `analytics_events` with userId, ipHash, and device
fingerprint. This contradicts the opt-in consent model.

**Legal basis:** Could be justified under "legitimate interest" (Art. 6(1)(f)), but requires:
1. Documented Legitimate Interest Assessment (LIA) — none exists
2. Privacy policy disclosure (server-side logging section exists in frontend — verified)
3. Opt-out mechanism for legitimate interest processing — none exists

---

### G4. Session Table Has No Cleanup

**Priority: High**

Sessions have `expiresAt` (7 days) but expired sessions are **never deleted**. Only rejected at
validation time (`auth.service.ts:297`). Raw IPs in `Session.ip` and unsalted hashes in
`Session.ipHash` persist indefinitely with no retention policy.

`User.registrationIp` also persists permanently with no retention policy.

---

### G5. Session Country Only Populated From CDN Headers

**Priority: Low** | File: `auth.service.ts:263`

The session's `country` field comes from `meta.country` (CDN header: cf-ipcountry, x-vercel-ip-country).
The GeoIP lookup result is used **only for timezone**, not country. Without a CDN (e.g., direct
deployment to Railway), country will always be null. The `geoResult?.country` is available but
never assigned to `data.country`.

---

## 4. Admin Underutilization Findings

### A1. Rich Analytics Locked Behind Separate Auth

**Priority: High** | Impact: 30+ dimensions invisible to admin through admin auth

`GET /api/analytics/stats` returns 30+ dimensions behind `AnalyticsGuard` (`X-Analytics-Key`).
The admin's `GET /api/admin/stats` returns only 9 basic DB counts. They measure fundamentally
different things — admin counts entities, analytics measures visitor behavior.

**Data available in analytics but not proxied through admin auth:**

Traffic timeseries, geographic breakdown, device/browser/OS distribution, referrer attribution,
UTM campaign attribution, hourly/weekday patterns, top pages, session duration (avg/P50/P95),
bounce rate, conversion funnel (3-stage with rates), funnel by UTM source/path, retention cohorts
(day1/7/30), likes, realtime active visitors.

**The admin dashboard IS comprehensive** — `/dashboard/analytics` renders ~25 of 30+ dimensions.
But it uses server-to-server `X-Analytics-Key`, not admin JWT auth. The gap is auth separation.

**Data fetched by admin dashboard but never rendered:**
- Funnel visualization (3 datasets: funnel, funnelByUtmSource, funnelByPath)
- OS distribution (fetched, transformed, no component)
- Duration percentiles P50/P95 (only avgDuration shown)
- `newMembersInRange`, `sales`

---

### A2. Server-Side Events Are Write-Only

**Priority: High** | Impact: 14 event types producing zero consumable output

14 server-side event types tracked across 7 modules go to PG buffer **only** — no Redis counters.
The `analytics_events` table receives every event but no endpoint queries it. All 14 events
confirmed present with correct type strings, guards, and ordering.

| Event Type | Source | Properties Stored |
|------------|--------|-------------------|
| `user_login` | AuthController | `{ username }` |
| `user_register` | AuthController | `{ username }` |
| `user_logout` | AuthController | — |
| `password_change` | AuthController | — |
| `review_created` | ReviewsService | `{ reviewId, companyId }` |
| `vote_cast` (review) | ReviewsService | `{ reviewId, voteType }` |
| `vote_cast` (helpful) | ReviewsService | `{ reviewId, helpful }` |
| `comment_created` | CommentsService | `{ commentId, reviewId, postId, complaintId }` |
| `vote_cast` (comment) | CommentsService | `{ commentId, voteType }` |
| `complaint_created` | ComplaintsService | `{ complaintId, companyId, productId }` |
| `vote_cast` (complaint) | ComplaintsService | `{ complaintId, voteType }` |
| `user_follow` | UsersService | `{ targetUserId, targetUsername }` |
| `user_unfollow` | UsersService | `{ targetUserId, targetUsername }` |
| `search_performed` | SearchService | `{ query, type, resultCount }` |

**Bug found:** `user_follow` and `user_unfollow` in `users.service.ts:156,199` omit the `country`
argument when calling `track()`, unlike all other 12 emission sites.

**Storage waste:** ~13M rows/month, ~6-7 GB/month (~76 GB/year) in PG with 3 indexes. The
`(eventType, createdAt)` composite index is sufficient for all proposed query patterns.

---

## 5. Data Flow Disconnects

### D1. Analytics SSR Bypasses Admin JWT Validation

The analytics page SSR path calls `getAnalyticsDashboardPayload()` directly with
`X-Analytics-Key` — no admin JWT check. The BFF route at `/api/analytics/stats` does check
admin JWT, but the SSR page doesn't use that route.

### D2. Admin Dashboard Needs Two Secrets

The admin dashboard requires both `ADMIN_API_KEY` and `ANALYTICS_API_KEY` env vars, synchronized
with the backend. The Phase B proxy approach eliminates the need for `ANALYTICS_API_KEY` in the
admin deployment.

---

## 6. Implementation Roadmap

### Effort Estimation

Estimates include all layers required by CLAUDE.md: source, DTOs, unit tests, e2e tests, and
admin dashboard changes.

### Phase A — Security + IP Privacy

**Backend PR. No admin/frontend coordination needed.**

| # | Fix | Source Lines | Test Lines | Notes |
|---|-----|-------------|------------|-------|
| S1-D | Stop writing ipHash to analytics_events | ~10 | ~10 | Remove from 5 pushToBuffer calls + buffer flush |
| S1-B | Add `IP_HASH_SALT` env var + upgrade hashIp() to HMAC | ~15 | ~20 | Update env schema, hashIp(), auth.service duplicate |
| S1-C | Hash IP in Redis cache key | 1 | ~5 | One-line change at `analytics.service.ts:399` |
| S3 | Generic error in latest-members + Logger | ~10 | ~15 | Add Logger to AnalyticsController |
| G2 | Backfill-null existing analytics_events.ip_hash | ~5 | — | One-time migration script |
| G5 | Use GeoIP country in createSession fallback | ~3 | ~5 | `data.country = meta.country \|\| geoResult?.country` |
| Bug | Add missing `country` arg to follow/unfollow track() | ~2 | — | `users.service.ts:156,199` |
| **Total** | | **~46** | **~55** | |

### Phase B — Admin Proxy Endpoints

**Backend + admin dashboard PR. Prerequisite: inject AnalyticsService into AdminService.**

| # | Task | Backend | Dashboard | Tests |
|---|------|---------|-----------|-------|
| B0 | Inject AnalyticsService + prerequisite wiring | ~10 | — | ~20 |
| B1 | Proxy analytics/health (also fixes S2) | ~15 | ~10 | ~30 |
| B2 | Proxy analytics/stats | ~30 + ~10 DTO | ~30 | ~50 |
| B3 | Proxy analytics/realtime | ~13 | ~10 | ~35 |
| B4 | Proxy analytics/latest-members | ~16 | ~10 | ~40 |
| B5 | Fix `lastActive` in user list | ~10 | — | ~15 |
| B6 | Enrich admin stats (totalComments, totalVotes, totalFollows, totalSessions) | ~15 | ~20 | ~20 |
| **Total** | | **~119 + DTO** | **~80** | **~210** |

**Phase B total: ~420 lines across 2 repos.**

### Phase C — Admin Intelligence

**Backend + admin dashboard PR. Make the analytics platform actually useful to admins.**

#### C-I: New backend endpoints (analytics_events read paths)

| # | Task | Backend | Dashboard | Tests | Notes |
|---|------|---------|-----------|-------|-------|
| C1 | Event aggregation endpoint | ~60 svc + ~20 ctrl | ~100 component | ~80 | groupBy eventType + daily timeseries (raw SQL for DATE()) |
| C2 | Notification analytics | ~50 svc + ~15 ctrl | ~100 component | ~60 | groupBy type, read rate, push delivery |
| C3 | Search query analytics | ~40 svc + ~15 ctrl | ~80 component | ~40 | Requires raw SQL for JSONB `properties->>'query'` |

#### C-II: Render already-fetched but unused analytics dimensions (dashboard-only, zero backend)

The admin dashboard already fetches these via `getAnalyticsDashboardPayload()` and passes them
through the payload — they just need components to render them.

| # | Task | Backend | Dashboard | Notes |
|---|------|---------|-----------|-------|
| C4 | Funnel visualization (signup → purchase conversion) | 0 | ~120 component | Data: `funnel`, `funnelByUtmSource`, `funnelByPath` — 3 datasets already in payload |
| C5 | OS distribution chart | 0 | ~60 component | Data: `byOs`, `osChartData` — already built in payload |
| C6 | Duration percentiles (P50/P95) | 0 | ~30 component | Data: `durationP50Seconds`, `durationP95Seconds` — already in payload, only avgDuration shown |
| C7 | Activity timeline page for user detail | 0 | ~80 page + ~10 BFF | Backend `GET /admin/users/:id/activity` already exists, no admin UI |
| C8 | Manual rollup trigger button | 0 | ~40 component + ~10 BFF | Backend `POST /admin/analytics/rollup` already exists, no admin UI |

| | **Phase C Total** | **~200** | **~630** | |
|---|---|---|---|---|

**Phase C total: ~1,010 lines across 2 repos** (backend ~200 + tests ~180 + dashboard ~630).

**Performance notes:** The `(eventType, createdAt)` composite index covers all query patterns.
At 13M rows/month, 30-day queries scan ~13M rows via index range scan — acceptable with 1-minute
caching. Search analytics scans only `search_performed` events (small fraction). No new indexes
needed at current scale.

### Phase Dependencies

```
Phase A (security + IP) ── no dependencies, land first
Phase B (admin proxy) ──── B0 is prerequisite for B1-B4
                           B1 (health proxy) resolves S2 for admin
Phase C (admin intelligence) ── independent of B
```

### PR Strategy

| PR | Content | Lines | Repos |
|----|---------|-------|-------|
| 1 | Phase A: security + IP privacy | ~101 | cryptoli |
| 2 | Phase B: admin proxy endpoints + stats enrichment | ~420 | cryptoli + cryptoi-admin |
| 3 | Phase C: admin intelligence | ~1,010 | cryptoli + cryptoi-admin |

---

## 7. Test Gaps to Address During Implementation

| Gap | Impact | When |
|-----|--------|------|
| Health endpoint e2e test hits /health without auth, expects 200 | Breaks when B1 adds guard | Phase B |
| `analytics.service.spec.ts:1213-1232` asserts deterministic unsalted hash | Breaks when S1-B adds salt | Phase A |
| Zero e2e tests for `GET /analytics/latest-members` | No coverage for S3 fix | Phase A |
| Zero test coverage for `latest-members` error path | No coverage for catch block | Phase A |
| Admin dashboard has zero page/component tests | No coverage for new Phase C components | Phase C |
