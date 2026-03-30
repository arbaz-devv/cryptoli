# Analytics Phase 2: Gap Analysis & Implementation Roadmap

> **Date:** 2026-03-30
> **Baseline:** main branches across 2 repos (see below)
> **Method:** 20 specialized Opus agents audited all codebases, verifying every claim against actual code with file:line evidence. 875 tool invocations, ~50 min cumulative runtime.
> **Scope:** Admin dashboard underutilization, data flow disconnects, minor fixes.
>
> | Repo | Local Path | Baseline Commit |
> |------|-----------|-----------------|
> | **cryptoli** (NestJS backend) | `~/Code/cryptoli` | fa1d85b |
> | **cryptoi-admin** (Next.js admin dashboard) | `~/Code/cryptoi-admin` | 5578a61 |

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
Adding a guard will break the dashboard unless it sends `X-Analytics-Key` (which it already has
in its env but doesn't include in the health check call).

**Fix:** Add `@UseGuards(AnalyticsGuard)` to the health endpoint (one decorator). Update
`checkAnalyticsHealth()` in the admin dashboard to send `X-Analytics-Key` header (it already
sends this header for stats/realtime/latest-members — health was just missed).

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

### F3. Server-Side Events Are Write-Only

**Priority: High** | Impact: 11 distinct event types across 14 emission sites producing zero consumable output

11 server-side event types tracked across 7 modules go to PG buffer **only** — no Redis counters.
The `analytics_events` table receives every event but no endpoint queries it. All emission sites
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

### F4. Data Fetched by Admin Dashboard but Never Rendered

**Priority: Medium**

The admin dashboard already fetches these via `getAnalyticsDashboardPayload()` and passes them
through the payload — they just need components to render them.

- Funnel visualization (3 datasets: `funnel`, `funnelByUtmSource`, `funnelByPath`)
- OS distribution (`byOs`, `osChartData` — already built in payload)
- Duration percentiles P50/P95 (`durationP50Seconds`, `durationP95Seconds` — only avgDuration shown)
- `newMembersInRange`, `sales`

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

### Phase A — Fixes

**Backend + admin dashboard PR.**

| # | Fix | Backend | Dashboard | Tests | Notes |
|---|-----|---------|-----------|-------|-------|
| F1 | Add `@UseGuards(AnalyticsGuard)` to health endpoint | ~1 | ~5 | ~15 | Dashboard: add `X-Analytics-Key` header to `checkAnalyticsHealth()` |
| F2 | Generic error in latest-members + Logger | ~10 | — | ~15 | Add Logger to AnalyticsController |
| F5 | Use GeoIP country in createSession fallback | ~3 | — | ~5 | `data.country = meta.country \|\| geoResult?.country` |
| Bug | Add missing `country` arg to follow/unfollow track() | ~2 | — | — | `users.service.ts:156,199` |
| B5 | Fix `lastActive` in user list | ~10 | — | ~15 | Use `updatedAt` instead of hardcoded `'-'` |
| B6 | Enrich admin stats (totalComments, totalVotes, totalFollows, totalSessions) | ~15 | ~20 | ~20 | Add 4 counters to `GET /admin/stats` |
| UD1 | User detail: render missing fields | — | ~20 | — | `username`, `registrationCountry`, `country`, `moderatedAt` — backend returns them, dashboard doesn't display |
| UD2 | User detail: add dates to reviews + complaints tables | — | ~10 | — | `reviews[].createdAt`, `complaints[].createdAt` — add date columns |
| UD3 | User detail: render discussions section | — | ~30 | — | Backend returns `discussions[]` (posts with title, commentCount, status, createdAt) — entire section unrendered |
| UD4 | User detail: return `userAgent` + `isCompanyProfile` from backend | ~5 | — | ~10 | Dashboard tries to render these but backend doesn't include them in the response |
| **Total** | | **~46** | **~85** | **~80** | |

**Phase A total: ~211 lines across 2 repos.**

### Phase B — Admin Intelligence

**Backend + admin dashboard PR. Make the analytics platform actually useful to admins.**

#### Dashboard Implementation Rules

All new dashboard components MUST reuse the existing UI system in `cryptoi-admin`. No new
libraries, no new patterns.

| Concern | Use | Source |
|---------|-----|--------|
| Charts | `recharts` (LineChart, BarChart, PieChart + ResponsiveContainer) | Already installed |
| Chart colors | `CHART_COLORS` from `@/lib/constants` + `<Cell>` per item | `lib/constants.ts:39` |
| Cards | `rounded-lg border border-admin bg-admin-card shadow-sm` with `border-b border-admin px-4 py-3` header | Pattern in every analytics section |
| Stat cards | `<StatCard>` from `@/components/StatCard` | `components/StatCard.tsx` |
| Skeletons | `<Skeleton>`, `<SkeletonCard>` from `@/components/Skeleton` | `components/Skeleton.tsx` |
| Empty states | `<EmptyState>` from `@/components/Skeleton` | `components/Skeleton.tsx` |
| Lazy render | Wrap below-fold sections in `<DeferredSection>` | `analytics/components/deferred/DeferredSection.tsx` |
| Tables | Inline `<table>` with standard thead/tbody pattern (no library) | Pattern in TopPagesSection, CountryTrafficSection |
| Text colors | `text-text-heading dark:text-foreground` (headings), `text-admin-muted` (descriptions), `text-admin-label` (labels) | globals.css tokens |
| Dark mode | Always pair via CSS vars (`bg-admin-card`, `text-text-dark dark:text-foreground`) | globals.css |
| Animations | CSS `animate-slide-up` for server components; framer-motion only if needed in client components | globals.css, `components/animations/easings.ts` |
| New sections | Place in `app/dashboard/analytics/components/`, import in `AnalyticsDashboard.tsx` | Existing pattern |
| Data flow | Add fields to `AnalyticsDashboardPayload`, compute in `getAnalyticsDashboardPayload()`, pass as props | `lib/analytics.ts` |
| Maps | `VisitorsFlowMap` component (react-simple-maps) if geographic | `analytics/components/VisitorsFlowMap.tsx` |

**Existing chart components to reference as templates:**
- BarChart: `PeakAndWeekdaySection.tsx`, `CountryTrafficSection.tsx`
- LineChart: `TrafficAndGoalsSection.tsx`
- PieChart/Donut: `DeviceAndBrowserSection.tsx`
- Table: `TopPagesSection.tsx`
- Stat cards: `OverviewCardsSection.tsx`
- Colored dot lists: `ReferrersUtmSection.tsx`

#### B-I: New backend endpoints (analytics_events read paths)

| # | Task | Backend | Dashboard | Tests | Notes |
|---|------|---------|-----------|-------|-------|
| B1 | Event aggregation endpoint | ~80 svc + ~20 ctrl | ~120 component | ~80 | groupBy eventType + daily timeseries + dimensional breakdowns (by country, device, browser, path, referrer, UTM) from analytics_events columns |
| B2 | Notification analytics | ~50 svc + ~15 ctrl | ~100 component | ~60 | groupBy type, read rate, push delivery |
| B3 | Search query analytics | ~40 svc + ~15 ctrl | ~80 component | ~40 | Requires raw SQL for JSONB `properties->>'query'` |

#### B-II: Render already-fetched but unused analytics dimensions (dashboard-only, zero backend)

| # | Task | Backend | Dashboard | Notes |
|---|------|---------|-----------|-------|
| B4 | Funnel visualization (signup → purchase conversion) | 0 | ~120 component | Data: `funnel`, `funnelByUtmSource`, `funnelByPath` — 3 datasets already in payload |
| B5 | OS distribution chart | 0 | ~60 component | Data: `byOs`, `osChartData` — already built in payload |
| B6 | Duration percentiles (P50/P95) | 0 | ~30 component | Data: `durationP50Seconds`, `durationP95Seconds` — already in payload, only avgDuration shown |
| B7 | Activity timeline page for user detail | 0 | ~80 page + ~10 BFF | Backend `GET /admin/users/:id/activity` already exists, no admin UI |
| B8 | Manual rollup trigger button + system health status | 0 | ~60 component + ~10 BFF | Backend `POST /admin/analytics/rollup` and `GET /analytics/health` already exist. Surface rollup trigger + `configured`, `connected`, `lastError`, `rollup.lastSuccessDate`, `rollup.stale` in one operations panel |
| B9 | Sales count + new members in range stat cards | 0 | ~15 component | Data: `sales`, `newMembersInRange` — already in payload, never destructured. Add to OverviewCardsSection or separate row |
| B10 | Wire `browserUsagePct` + `visitorsByCountryPct` into existing sections | 0 | ~10 | Already computed in `lib/analytics.ts:449-459`, never passed to components. Wire into DeviceAndBrowserSection and CountryTrafficSection as percentage labels |

| | **Phase B Total** | **~220** | **~725** | |
|---|---|---|---|---|

**Phase B total: ~1,125 lines across 2 repos** (backend ~220 + tests ~180 + dashboard ~725).

**Performance notes:** The `(eventType, createdAt)` composite index covers all query patterns.
At 13M rows/month, 30-day queries scan ~13M rows via index range scan — acceptable with 1-minute
caching. Search analytics scans only `search_performed` events (small fraction). No new indexes
needed at current scale.

### Phase Dependencies

```
Phase A (fixes) ──── no dependencies, land first
Phase B (admin intelligence) ── independent of A
```

### PR Strategy

| PR | Content | Lines | Repos |
|----|---------|-------|-------|
| 1 | Phase A: fixes + stats enrichment + user detail completion | ~211 | cryptoli + cryptoi-admin |
| 2 | Phase B: admin intelligence | ~1,125 | cryptoli + cryptoi-admin |

---

## 4. Test Gaps to Address During Implementation

| Gap | Impact | When |
|-----|--------|------|
| Health endpoint e2e test hits /health without auth, expects 200 | Breaks when F1 adds guard | Phase A |
| Zero e2e tests for `GET /analytics/latest-members` | No coverage for F2 fix | Phase A |
| Zero test coverage for `latest-members` error path | No coverage for catch block | Phase A |
| Admin dashboard has zero page/component tests | No coverage for new Phase B components | Phase B |
