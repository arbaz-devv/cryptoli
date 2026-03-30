# Analytics Phase 2: Combined Gap Analysis & Implementation Roadmap

> **Date:** 2026-03-30
> **Baseline:** main branches across 3 repos — cryptoli (fa1d85b), cryptoi-admin (5578a61), cryptoli-frontend (be97f28)
> **Method:** 20 specialized Opus agents audited all 3 codebases, verifying every claim against actual code with file:line evidence. 875 tool invocations, ~50 min cumulative runtime.
> **Scope:** Security gaps, admin dashboard underutilization, data flow disconnects, GDPR compliance.

---

## Table of Contents

1. [Platform Status](#1-platform-status)
2. [The Core Problem](#2-the-core-problem)
3. [Security Findings](#3-security-findings) (S1–S6)
4. [GDPR Findings](#4-gdpr-findings) (G1–G5)
5. [Admin Underutilization Findings](#5-admin-underutilization-findings) (A1–A4)
6. [Data Flow Disconnects](#6-data-flow-disconnects) (D1–D5)
7. [Dead Code & Placeholders](#7-dead-code--placeholders) (X1–X12)
8. [Implementation Roadmap](#8-implementation-roadmap)
9. [Mechanical Baseline](#9-mechanical-baseline)

---

## 1. Platform Status

### What Was Built (PR #4 + follow-up fixes)

| Layer | Component | Status |
|-------|-----------|--------|
| **Backend** | AnalyticsBufferService (in-memory → PG flush, 2s interval) | Operational |
| | AnalyticsRollupService (Redis → PG daily summaries, hourly) | Operational |
| | 14 server-side event types across 7 modules | Operational — but **write-only** |
| | Session enrichment (9 fields: ip, ipHash, userAgent, device, browser, os, country, timezone, trigger) | Operational |
| | User enrichment (registrationIp, registrationCountry) | Operational |
| | Hybrid getStats() (Redis < 28d, PG ≥ 28d) | Operational |
| | GDPR anonymization (90-day userId nullification) | Operational — but **incomplete** |
| | Bot filtering, consent gate | Operational |
| | Admin endpoints (sessions, export, activity, rollup) | Operational |
| | Analytics endpoints (stats, realtime, latest-members, health) | Operational |
| | 745 tests (593 unit + 57 integration + 95 e2e) | All passing |
| **Admin** | Analytics dashboard (~25 of 30+ dimensions rendered) | Operational |
| | Session history page with CSV/JSON export | Operational |
| | User detail with enrichment fields | Operational |
| | BFF proxy routes for analytics + admin endpoints | Operational |
| **Frontend** | AnalyticsTracker (credentials:include, keepalive, no sendBeacon) | Operational |
| | Consent v2 cookie, expanded privacy disclosures (5 locales) | Operational |
| | Like tracking, signup_started tracking | Operational |

### Test Inventory

| Repo | Framework | Unit | Integration | E2E | Total |
|------|-----------|------|-------------|-----|-------|
| cryptoli | Jest | 593 | 57 | 95 | 745 |
| cryptoi-admin | Vitest | 17 | — | — | 17 |
| cryptoli-frontend | Vitest | 12 | — | — | 12 |

---

## 2. The Core Problem

The analytics platform is a **fully operational write machine with a severely underbuilt read layer**. Data flows in from 3 sources (frontend tracking, server-side events, session enrichment) through well-tested pipelines. But the read paths serve only ~60% of what's collected:

| Storage | Write Path | Read Path | Utilization |
|---------|-----------|-----------|-------------|
| Redis counters (22+ key patterns per day) | `track()` page_view/page_leave/like/funnel | `getStats()`, `getRealtime()` | **Well-utilized** |
| `analytics_daily_summaries` (EAV, ~300 rows/day) | Rollup service | `getStats()` historical range | **Well-utilized** |
| `analytics_events` (17 cols, ~13M rows/month) | Buffer service flush every 2s | **Zero user-facing reads** | **Complete waste — ~76 GB/year** |
| Server-side events (14 types, 7 modules) | `track()` → PG buffer only (no Redis) | **No endpoint queries this data** | **Complete waste** |
| Session enrichment (9 fields) | `createSession()` | Admin user detail, session list, export | **Well-utilized** |

---

## 3. Security Findings

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
3. Admin impact: Session.ipHash is display-only (never compared, joined, or filtered). Old sessions
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

No K8s/infrastructure probes depend on this endpoint (no Dockerfile, docker-compose, or manifests
found).

**Breaking change:** The admin dashboard's `checkAnalyticsHealth()` at
`cryptoi-admin/lib/analytics.ts:104-141` calls this endpoint with **NO authentication headers**.
Adding a guard will cause the dashboard to show "Analytics not configured" permanently.

**Fix:** Add `@UseGuards(AnalyticsGuard)` (one decorator). Simultaneously update the admin
dashboard to send `X-Analytics-Key`. If P0 proxy endpoints land first, admin calls go through
`/api/admin/analytics/health` with AdminGuard and the direct endpoint can be gated without
coordination.

**Tests:** Update `test/e2e/analytics.e2e-spec.ts:118-133` (hits /health without auth, expects 200).
Add guard-presence assertion in `analytics.controller.spec.ts`.

---

### S3. Redis Cache Key Leaks Plaintext IP

**Priority: Low** | File: `analytics.service.ts:399`

```typescript
const cacheKey = `${KEY_PREFIX}:ip_country:${normalizedIp}`;
```

This is the **only** Redis key with plaintext IP in the key name (verified against full 29-key
inventory). 30-day TTL. `SCAN analytics:ip_country:*` enumerates all resolved visitor IPs.

**Fix:** One line — `const cacheKey = \`${KEY_PREFIX}:ip_country:${this.hashIp(normalizedIp)}\``.
Coordinates cleanly with S1 hashIp() changes. Cache misses during transition are benign (fall
through to GeoIP lookup, ~30 day cold window).

---

### S4. Timing-Unsafe API Key Comparison

**Priority: Low** | Files: `analytics.guard.ts:27`, `admin.guard.ts:26`

Both guards use `===` for API key comparison. Zero uses of `crypto.timingSafeEqual()` anywhere in
the codebase. Practically unexploitable over HTTPS but flagged by CVE-2025-59425, CWE-208, OWASP.

**Fix:** Shared `safeCompare()` utility + 2 call-site changes. Existing behavior (accept/reject)
stays identical. Zero impact on admin auth flow.

```typescript
import { timingSafeEqual } from 'crypto';
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
```

---

### S5. Error Leakage in latest-members

**Priority: Low** | File: `analytics.controller.ts:142-146`

Returns raw `e.message` to API caller. Only such pattern across all controllers (4 other `e.message`
references in `auth.controller.ts` are safe — they throw `BadRequestException` with Zod validation
messages). The analytics controller has **no Logger instance** — one must be added.

The admin dashboard at `cryptoi-admin/lib/analytics.ts` already catches and ignores errors (returns
`[]`), so admin is unaffected.

**Fix:**
```typescript
private readonly logger = new Logger(AnalyticsController.name);
// In catch block:
this.logger.error('Failed to fetch latest members', e instanceof Error ? e.stack : String(e));
return { ok: false, error: 'Failed to fetch latest members' };
```

---

### S6. Dead Export `const dynamic`

**Priority: Trivial** | File: `analytics.service.ts:141`

```typescript
export const dynamic = 'force-dynamic';
```

Next.js App Router route segment config — inert in NestJS. Zero imports. Delete the line.

---

## 4. GDPR Findings

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

## 5. Admin Underutilization Findings

### A1. Rich Analytics Locked Behind Separate Auth

**Priority: High** | Impact: 30+ dimensions invisible to admin

`GET /api/analytics/stats` returns 30+ dimensions behind `AnalyticsGuard` (`X-Analytics-Key`).
The admin's `GET /api/admin/stats` returns only 9 basic DB counts. They measure fundamentally
different things — admin counts entities, analytics measures visitor behavior.

**Data available in analytics but invisible through admin auth:**

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

### A3. Data Models With Zero Admin Visibility

**Priority: Medium** | 5 of 22 models have zero admin reach

| Model | Schema Location | Admin Visibility | Status |
|-------|----------------|------------------|--------|
| **Report** | `schema.prisma:427-436` | **Zero — dead code** | No service reads or writes `prisma.report.*` anywhere. 4 status enum values defined but unused. |
| **Notification** | `schema.prisma:290-307` | **Zero** | 12 types, full user-facing CRUD via NotificationsService. Zero admin endpoints. |
| **CompanyFollow** | `schema.prisma:334-343` | **Zero** | Used in public company listing (`_count`) only. No admin query. |
| **Media** | `schema.prisma:257-265` | **Zero** | `prisma.media.*` never called directly anywhere. Completely invisible. |
| **PushSubscription** | `schema.prisma:309-320` | **Zero** | Managed by PushService. No admin visibility. |

**Models with partial admin visibility (nested only):**
- **Post** — 8 truncated posts in user detail. No independent listing/search/moderation.
- **Reaction** — Per-review type counts in review detail. No platform-wide breakdown.
- **Comment** — Nested in review detail. No global comment listing/moderation.
- **Follow** (user-to-user) — In activity timeline only. No aggregated view.

---

### A4. Admin Dashboard Presentation Issues

**Priority: Low–Medium**

#### Confirmed hardcoded/placeholder values

| Issue | Location | Value | Root Cause |
|-------|----------|-------|------------|
| `lastActive` always `'-'` in user list | `admin.service.ts:323` | Hardcoded `'-'` | List query doesn't fetch `updatedAt` or sessions |
| `newFeedbacks` always `0` | `admin.service.ts:227` | Hardcoded `0` | No Feedback model exists in schema |
| `adminNotes` always `null` | `admin.service.ts:748` | Hardcoded `null` | No `adminNotes` column on Complaint model |
| `feedbacks: []` always empty | `admin.service.ts:404,608` | Hardcoded `[]` | Same as above — no Feedback model |
| `totalRatings` misleading name | `admin.service.ts:224` | `prisma.product.count()` | Actually counts products, not ratings |
| Discussion status always `'open'` | `admin.service.ts:605` | Hardcoded `'open'` | Post model has no status field |
| `trend` never `'down'` | `admin.service.ts:1172` | Binary logic | Only checks if `newThisWeek > 0` |

#### Admin dashboard fake data pages

| Page | File | Status |
|------|------|--------|
| `/dashboard/alerts` | `alerts/page.tsx` | **100% fake** — `fakeAlerts` from `fakeData.ts` |
| `/dashboard/feedbacks` | `feedbacks/page.tsx` | **100% fake** — `fakeFeedbacks` from `fakeData.ts` |
| `/dashboard/feedbacks/[id]` | `feedbacks/[id]/page.tsx` | **100% fake** — `getFeedbackById()` |

#### Backend endpoints with no admin dashboard UI

| Endpoint | Status |
|----------|--------|
| `GET /api/admin/users/:id/activity` | No API client function, no BFF route, no page |
| `POST /api/admin/analytics/rollup` | No API client function, no BFF route, no UI button |
| `GET /api/admin/ratings` | API client + BFF route exist, **no dashboard page** |

---

## 6. Data Flow Disconnects

### D1. Analytics SSR Bypasses Admin JWT Validation

The analytics page SSR path calls `getAnalyticsDashboardPayload()` directly with
`X-Analytics-Key` — no admin JWT check. The BFF route at `/api/analytics/stats` does check
admin JWT, but the SSR page doesn't use that route.

### D2. Admin Dashboard Needs Two Secrets

The admin dashboard requires both `ADMIN_API_KEY` and `ANALYTICS_API_KEY` env vars, synchronized
with the backend. The P0 proxy approach eliminates the need for `ANALYTICS_API_KEY` in the admin
deployment.

### D3. Frontend-to-Backend Consent Flow Is Correct

Verified end-to-end: `getAnalyticsConsent() !== true` → bail. Cookie name `analytics_consent_v2`.
All payloads include `consent: true`. Backend checks `if (!body.consent) return;` (opt-in). No
gaps in the frontend consent pipeline.

### D4. CORS Configuration Is Correct

`credentials: true` in CORS config. Origin checked from `CORS_ORIGIN` env var. CSRF middleware
skips requests without session cookie (anonymous analytics POSTs pass through). Cross-origin
auth cookies are forwarded correctly.

### D5. Redis Key `analytics:first_visit:{day}` Is Write-Only

Written at `analytics.service.ts:527` (`HSETNX`) on every page_view. **Never read by any code.**
The parallel `analytics:cohort:{day}` set serves the same cohort-tracking purpose and IS read by
`computeRetention()`. This key is pure waste.

---

## 7. Dead Code & Placeholders

| # | Item | Location | Details | Action |
|---|------|----------|---------|--------|
| X1 | `export const dynamic` | `analytics.service.ts:141` | Next.js artifact, zero imports | Delete |
| X2 | `cache-control.ts` | `src/common/cache-control.ts` | 91 lines, 3 exports, zero imports | Delete file |
| X3 | `api.controller.ts` | `src/api.controller.ts` | Dead per CLAUDE.md, not in any module | Leave (documented) |
| X4 | `data.service.ts` | `src/data.service.ts` | Dead per CLAUDE.md, not in any module | Leave (documented) |
| X5 | `ReviewStatusQueryDto` | `src/admin/dto/review-status-query.dto.ts` | Re-exported but never imported | Delete |
| X6 | Report model | `schema.prisma:427-436` | Zero service code reads or writes it | Leave until implemented |
| X7 | `first_visit:{day}` Redis key | `analytics.service.ts:527` | Written, never read | Remove write |
| X8 | Alerts page | `cryptoi-admin/dashboard/alerts` | 100% fake data, no backend | Mark as placeholder |
| X9 | Feedbacks page | `cryptoi-admin/dashboard/feedbacks` | 100% fake data, no backend | Mark as placeholder |
| X10 | `newFeedbacks` stat | `admin.service.ts:227` | Hardcoded 0, no model | Remove or mark TBD |
| X11 | `adminNotes` field | `admin.service.ts:748` | Hardcoded null, no column | Remove or implement |
| X12 | Redundant global module imports | `analytics.module.ts:11`, `admin.module.ts:12`, `users.module.ts:9` | Import `PrismaModule`/`ConfigModule` which are `@Global()` | Harmless, low priority |

---

## 8. Implementation Roadmap

### Effort Estimation Methodology

Original estimates counted only backend service/controller source code. The
corrected estimates below include all layers required by CLAUDE.md: DTOs, unit tests, e2e tests,
and admin dashboard changes. The multiplier is approximately 3-5x.

### Phase A — Zero-Risk Security Fixes

**No coordination required. Single backend PR.**

| # | Fix | Source Lines | Test Lines | Risk |
|---|-----|-------------|------------|------|
| S6 | Delete `export const dynamic` | 1 | 0 | Zero |
| X1 | Delete `cache-control.ts` | 0 (file deletion) | 0 | Zero |
| X7 | Remove `first_visit` write | ~3 | ~2 | Zero |
| S5 | Generic error in latest-members + Logger | ~10 | ~15 | Zero |
| S3 | Hash IP in Redis cache key | 1 | ~5 | Zero |
| S4 | Timing-safe comparison in both guards | ~20 | ~15 | Zero |
| **Total** | | **~35** | **~37** | |

### Phase B — IP Privacy Overhaul

**Backend PR. No admin/frontend coordination needed.**

| # | Fix | Source Lines | Test Lines | Notes |
|---|-----|-------------|------------|-------|
| S1-D | Stop writing ipHash to analytics_events | ~10 | ~10 | Remove from 5 pushToBuffer calls + buffer flush |
| S1-B | Add `IP_HASH_SALT` env var + upgrade hashIp() to HMAC | ~15 | ~20 | Update env schema, hashIp(), auth.service duplicate |
| G2 | Backfill-null existing analytics_events.ip_hash | ~5 | — | One-time migration script |
| **Total** | | **~30** | **~30** | |

### Phase C — Admin Proxy Endpoints (P0)

**Backend + admin dashboard PR. Prerequisite: inject AnalyticsService into AdminService.**

| # | Task | Backend | Dashboard | Tests |
|---|------|---------|-----------|-------|
| C0 | Inject AnalyticsService + prerequisite wiring | ~10 | — | ~20 |
| C1 | Proxy analytics/health (also fixes S2) | ~15 | ~10 | ~30 |
| C2 | Proxy analytics/stats | ~30 + ~10 DTO | ~30 | ~50 |
| C3 | Proxy analytics/realtime | ~13 | ~10 | ~35 |
| C4 | Proxy analytics/latest-members | ~16 | ~10 | ~40 |
| C5 | Fix `lastActive` in user list (A4) | ~10 | — | ~15 |
| C6 | Enrich admin stats (promoted from P1) | ~15 | ~20 | ~20 |
| **Total** | | **~119 + DTO** | **~80** | **~210** |

**Phase C total: ~420 lines across 2 repos.**

### Phase D — Event Query Layer (P1)

**Backend + admin dashboard PR. The big unlock for write-only data.**

| # | Task | Backend | Dashboard | Tests | Notes |
|---|------|---------|-----------|-------|-------|
| D1 | Event aggregation endpoint | ~60 svc + ~20 ctrl | ~100 component | ~80 | groupBy eventType + daily timeseries (raw SQL for DATE()) |
| D2 | Notification analytics | ~50 svc + ~15 ctrl | ~100 component | ~60 | groupBy type, read rate, push delivery |
| D3 | Search query analytics | ~40 svc + ~15 ctrl | ~80 component | ~40 | Requires raw SQL for JSONB `properties->>'query'` |
| **Total** | | **~200** | **~280** | **~180** | |

**Phase D total: ~660 lines across 2 repos.**

**Performance notes:** The `(eventType, createdAt)` composite index covers all query patterns.
At 13M rows/month, 30-day queries scan ~13M rows via index range scan — acceptable with 1-minute
caching. Search analytics scans only `search_performed` events (small fraction). No new indexes
needed at current scale.

### Phase E — Admin CRUD & Visibility (P2)

| # | Task | Backend | Dashboard | Tests |
|---|------|---------|-----------|-------|
| E1 | Platform-wide comment management | ~80 | ~120 | ~80 |
| E2 | Post management for admins | ~70 | ~100 | ~60 |
| E3 | Trending content admin view | ~40 | ~80 | ~30 |
| E4 | Company follow analytics | ~50 | ~60 | ~40 |
| E5 | Admin notes on complaints (schema change) | ~30 | ~40 | ~30 |
| **Total** | | **~270** | **~400** | **~240** |

### Phase F — Future Consideration (P3)

| Task | Effort Estimate | Notes |
|------|----------------|-------|
| Implement Report model CRUD | ~500 total | Dead model needs full service + admin UI |
| Media management | ~400 total | Zero existing implementation |
| Per-company/product analytics | ~400 total | JSONB queries, may need GIN index at scale |
| Reaction CRUD and analytics | ~350 total | Per-type breakdown, trends |
| Feedback model + CRUD | ~500 total | New model, migration, endpoints, dashboard |
| Session cleanup cron (G4) | ~100 total | Delete expired sessions, retention policy |
| User deletion endpoint (G1) | ~300 total | Wire anonymizeUserAnalytics, cascade considerations |

### Phase Dependencies

```
Phase A (security) ──── no dependencies, land immediately
Phase B (IP privacy) ── no dependencies, can parallel with A
Phase C (proxy) ─────── C0 is prerequisite for C1-C4
                        C1 (health proxy) replaces S2 fix for admin
Phase D (event queries) ── independent of C
Phase E (admin CRUD) ──── independent of C and D
Phase F (future) ──────── G1 (deletion) depends on application-wide design decision
```

### PR Strategy

| PR | Content | Lines | Repos |
|----|---------|-------|-------|
| 1 | Phase A: zero-risk security fixes + dead code removal | ~72 | cryptoli |
| 2 | Phase B: IP privacy overhaul | ~60 | cryptoli |
| 3 | Phase C: admin proxy endpoints + stats enrichment | ~420 | cryptoli + cryptoi-admin |
| 4 | Phase D: event query layer | ~660 | cryptoli + cryptoi-admin |
| 5+ | Phase E: individual PRs per feature | ~200-300 each | cryptoli + cryptoi-admin |

---

## 9. Mechanical Baseline

All checks pass at HEAD across all 3 repos:

**cryptoli (backend):**
```
Tests:     PASS — 745 total (593 unit + 57 integration + 95 e2e)
Build:     PASS
Typecheck: PASS (tsc --noEmit)
Lint:      PASS (22 pre-existing warnings, none introduced by analytics)
```

**cryptoi-admin (admin dashboard):**
```
Tests:     PASS — 17 tests
Build:     PASS
```

**cryptoli-frontend (frontend):**
```
Tests:     PASS — 12 tests
Build:     PASS
```

---

## Appendix: Test Gaps to Address During Implementation

| Gap | Impact | When |
|-----|--------|------|
| Health endpoint e2e test hits /health without auth, expects 200 | Breaks when S2/C1 adds guard | Phase C |
| `analytics.service.spec.ts:1213-1232` asserts deterministic unsalted hash | Breaks when S1-B adds salt | Phase B |
| Zero e2e tests for `GET /analytics/latest-members` | No coverage for S5 fix | Phase A |
| Zero test coverage for `latest-members` error path | No coverage for catch block | Phase A |
| Admin dashboard has zero page/component tests | No coverage for new P1 components | Phase D |
| Frontend CookieConsent has no tests | Consent API changes untested | Future |
| `user_follow`/`user_unfollow` missing `country` arg in track() call | Events lack country data | Phase A or B |
