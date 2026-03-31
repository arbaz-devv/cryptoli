---
Status: Implemented
Last verified: 2026-03-31
---

# Analytics System

> Source of truth: `src/analytics/analytics.service.ts`.
> If this spec contradicts the code, the code is correct — update this spec.

<!-- Review when src/analytics/ changes -->

## Overview

Privacy-first (GDPR opt-in), dual-storage (Redis hot + PostgreSQL cold),
fire-and-forget analytics pipeline. Client-side events go through Redis
counters AND PG buffer; server-side events go to PG buffer only.

## Non-Goals

- Client-side analytics SDK (frontend responsibility)
- Real-time dashboards via WebSocket (stats are polled via REST)
- Sub-second accuracy for HyperLogLog-based unique counts
- Custom event schemas beyond the flat `properties` JSON field

## Key Patterns

### Consent Model (GDPR)

`track()` returns immediately if `consent` is not explicitly `true`.
`false`, `undefined`, or omitted = zero storage. This is opt-in, not opt-out.
Consent check runs before bot detection (via `isBot` from ua-parser-js).

### Data Flow

**Client-side events** (page_view, page_leave, funnel events):
`POST /track` → consent check → Redis pipeline (counters, HLL, sorted sets)
+ PG buffer → flush to `AnalyticsEvent` table.

**Server-side events** (review_created, vote_cast, comment_created, etc.):
Controller passes `req.analyticsCtx` → service calls `track()` → PG buffer
only. No Redis counters for server-side events.

### Fire-and-Forget

`POST /track` returns `{ ok: true }` synchronously via `void track(...)`.
The Redis pipeline and buffer push happen asynchronously. Tests that assert
on Redis state after `track()` need a ~200ms delay + `redis.ping()` to flush
the ioredis command queue.

### Redis Pipeline

All Redis writes for a page_view event use one `pipeline()` call (~38-40 commands:
INCR, PFADD, HINCRBY, ZADD, HSETNX, SADD). Each key gets its own EXPIRE
(32-day TTL). Pipeline errors feed `redisService.setLastError()` — they do
not throw.

Key naming: `analytics:{metric}:{YYYY-MM-DD}` (e.g., `analytics:pageviews:2026-03-27`).

### PG Buffer (AnalyticsBufferService)

In-memory event buffer: flushes every 2 seconds or at 500 events (whichever
comes first). Max buffer size: 2000 — overflow silently drops events with a
log warning. Uses `SET LOCAL synchronous_commit = off` for write performance.
`prisma.analyticsEvent.createMany()` (no deduplication in buffer — the rollup
service uses `skipDuplicates`, but the buffer does not).

### Rollup (AnalyticsRollupService)

Hourly timer converts Redis day-snapshots to `AnalyticsDailySummary` EAV rows.
32-day backfill on first startup, 2-day on subsequent runs.

Idempotency: Redis NX lock (fast-path) → PG existence check (primary guard) →
write → set Redis NX lock AFTER PG write. P2002 (unique constraint violation)
treated as concurrent-rollup success. NX lock set after PG write ensures crash
safety.

### Hybrid Stats Read

`getStats()` partitions the date range: days ≥ 28 days ago read from PG's
`AnalyticsDailySummary`; recent days read from Redis. PG uniques are summed
per-day snapshots (approximate, overcounts 3-20%); Redis provides exact HLL
union for its window. In-memory stats cache: 1-minute TTL, per-instance `Map`.

### Bounce Detection

Bounce = single-pageview session + `page_leave` within 30 seconds. Two-step
(HGET then conditional INCR) — not pipelined, not idempotent. Duplicate
`page_leave` events can double-count bounces.

### Retention

Hourly background computation for last 35 days. Cohort sets (SADD on first
visit day) cross-referenced with session_pages hashes via SMEMBERS. Results
cached as JSON in Redis (48h TTL). Read from pre-computed cache in `getStats()`.

### GDPR Compliance

- IP hashed (SHA-256), never stored raw
- 90-day `userId` anonymization via hourly timer with Redis once-per-day guard
- `anonymizeUserAnalytics(userId)` hook for account deletion (nullifies userId)
- Both use `SET LOCAL synchronous_commit = off`

### Path Normalization

Numeric segments, hex strings, and UUIDs are collapsed to `:id`
(e.g., `/reviews/abc123` → `/reviews/:id`). Build path-specific features
with this normalization in mind.

## Integration Pattern

For feature modules that track server-side events:

1. Import `AnalyticsModule` in the feature module
2. Apply `@UseInterceptors(AnalyticsInterceptor)` on the controller (class-level)
3. Read context via `req.analyticsCtx` (populated by the interceptor)
4. Pass to service method → `void this.analyticsService.track(...)` (fire-and-forget)
5. `AnalyticsService` is injected with `@Optional()` — analytics absence never breaks the app

Currently adopted by 7 controllers: analytics, auth, reviews, comments,
complaints, users, search.

**AnalyticsGuard vs AnalyticsInterceptor** — these are separate mechanisms:
- `AnalyticsGuard`: fail-closed API key check (`X-Analytics-Key` header) on
  analytics dashboard endpoints. If `ANALYTICS_API_KEY` is empty/absent,
  all guarded endpoints reject. Guarded endpoints: `stats`, `health`,
  `realtime`, `events`, `notifications`, `search-queries`, `latest-members`
  (7 total).
- `AnalyticsInterceptor`: populates `req.analyticsCtx` for server-side tracking
  in feature controllers. No authentication — just context extraction.

## Admin Intelligence Endpoints

Three read-only endpoints for event aggregation, notification analytics, and
search query analytics — added in Phase 3. All use `AnalyticsGuard` and
return `{ ok, data?, error? }`. A module-level `isValidDateParam()` validates
`from`/`to` query params as `YYYY-MM-DD` format.

| Endpoint | Query Params | Service Method | Cache |
|----------|-------------|----------------|-------|
| `GET /analytics/events` | `from`, `to`, `eventType?` | `getEventAggregation()` | `eventAggregationCache` |
| `GET /analytics/notifications` | `from`, `to` | `getNotificationAnalytics()` | `notificationAnalyticsCache` |
| `GET /analytics/search-queries` | `from`, `to` | `getSearchQueryAnalytics()` | `searchQueryAnalyticsCache` |

**Event aggregation** uses Prisma `groupBy` for 10 dimensional breakdowns
(country, device, browser, os, path, referrer, UTM source/medium/campaign,
event type) and `$queryRaw` for daily timeseries (`date_trunc`). All 12
queries run in parallel via `Promise.all`.

**Notification analytics** uses a single `$queryRaw` with PostgreSQL
`FILTER (WHERE ...)` for per-type read/pushed counts. Rates computed as
percentages rounded to 2 decimal places.

**Search query analytics** runs 5 parallel queries: total count, daily
timeseries, top queries with per-query avg `resultCount` (JSONB
`->>'query'` extraction), breakdown by search type, and overall avg
`resultCount`.

All three caches follow the `statsCache` pattern: in-process `Map` with
1-minute TTL (`STATS_CACHE_TTL_MS`), keyed by date range (+ `eventType`
for events). These are module-level constants (survive across requests,
not across restarts).

**Additional guarded endpoints** (not new but previously undocumented):
- `GET /analytics/health` — returns `{ enabled, configured, connected,
  lastError, rollup: { lastSuccessDate, stale } }`. Uses Logger for errors,
  returns generic error message (never leaks internals).
- `GET /analytics/latest-members` — returns recent registrations with
  `limit` param (default 8, clamped 1-20). Error handler logs via
  `Logger.error`, returns generic `'Failed to fetch latest members'`.

## Verification

```
grep -rn 'consent' src/analytics/analytics.service.ts | head -5
grep -rn 'buildVoteCounterDelta\|analyticsCtx' src/reviews/ src/comments/ src/complaints/
grep -rn '@UseInterceptors(AnalyticsInterceptor)' src/
grep -rn '@Optional.*AnalyticsService\|AnalyticsService.*@Optional' src/
grep -rn 'synchronous_commit' src/analytics/
grep -rn 'AnalyticsGuard' src/analytics/
grep -rn 'isValidDateParam' src/analytics/analytics.controller.ts
grep -rn 'eventAggregationCache\|notificationAnalyticsCache\|searchQueryAnalyticsCache' src/analytics/
```
