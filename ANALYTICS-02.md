# Analytics Phase 2: Gap Analysis & Implementation Roadmap

> **Date:** 2026-03-30
> **Baseline:** main branches across 3 repos — cryptoli (fa1d85b), cryptoi-admin (5578a61), cryptoli-frontend (be97f28)
> **Method:** 20 specialized Opus agents audited all 3 codebases, verifying every claim against actual code with file:line evidence. 875 tool invocations, ~50 min cumulative runtime.
> **Scope:** Admin dashboard underutilization, data flow disconnects, minor fixes.

---

## Table of Contents

1. [The Core Problem](#1-the-core-problem)
2. [Findings](#2-findings) (F1–F5)
3. [Implementation Roadmap](#3-implementation-roadmap)
4. [Test Gaps to Address During Implementation](#4-test-gaps-to-address-during-implementation)

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

## 2. Findings

### F1. Health Endpoint Information Disclosure

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

### F2. Error Leakage in latest-members

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

### F3. Rich Analytics Locked Behind Separate Auth

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

### F4. Server-Side Events Are Write-Only

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

### F5. Session Country Not Populated Without CDN

**Priority: Low** | File: `auth.service.ts:263`

The session's `country` field comes from `meta.country` (CDN header: cf-ipcountry, x-vercel-ip-country).
The GeoIP lookup result is used **only for timezone**, not country. Without a CDN (e.g., direct
deployment to Railway), country will always be null. The `geoResult?.country` is available but
never assigned to `data.country`.

**Fix:** One-line fallback: `data.country = meta.country || geoResult?.country || null`

---

## 3. Implementation Roadmap

### Effort Estimation

Estimates include all layers required by CLAUDE.md: source, DTOs, unit tests, e2e tests, and
admin dashboard changes.

### Phase A — Minor Fixes

**Backend PR. No admin/frontend coordination needed.**

| # | Fix | Source Lines | Test Lines | Notes |
|---|-----|-------------|------------|-------|
| F2 | Generic error in latest-members + Logger | ~10 | ~15 | Add Logger to AnalyticsController |
| F5 | Use GeoIP country in createSession fallback | ~3 | ~5 | `data.country = meta.country \|\| geoResult?.country` |
| Bug | Add missing `country` arg to follow/unfollow track() | ~2 | — | `users.service.ts:156,199` |
| **Total** | | **~15** | **~20** | |

### Phase B — Admin Proxy Endpoints

**Backend + admin dashboard PR. Prerequisite: inject AnalyticsService into AdminService.**

| # | Task | Backend | Dashboard | Tests |
|---|------|---------|-----------|-------|
| B0 | Inject AnalyticsService + prerequisite wiring | ~10 | — | ~20 |
| B1 | Proxy analytics/health (also fixes F1) | ~15 | ~10 | ~30 |
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
Phase A (minor fixes) ──── no dependencies, land first
Phase B (admin proxy) ──── B0 is prerequisite for B1-B4
                           B1 (health proxy) resolves F1 for admin
Phase C (admin intelligence) ── independent of B
```

### PR Strategy

| PR | Content | Lines | Repos |
|----|---------|-------|-------|
| 1 | Phase A: minor fixes | ~35 | cryptoli |
| 2 | Phase B: admin proxy endpoints + stats enrichment | ~420 | cryptoli + cryptoi-admin |
| 3 | Phase C: admin intelligence | ~1,010 | cryptoli + cryptoi-admin |

---

## 4. Test Gaps to Address During Implementation

| Gap | Impact | When |
|-----|--------|------|
| Health endpoint e2e test hits /health without auth, expects 200 | Breaks when B1 adds guard | Phase B |
| Zero e2e tests for `GET /analytics/latest-members` | No coverage for F2 fix | Phase A |
| Zero test coverage for `latest-members` error path | No coverage for catch block | Phase A |
| Admin dashboard has zero page/component tests | No coverage for new Phase C components | Phase C |
