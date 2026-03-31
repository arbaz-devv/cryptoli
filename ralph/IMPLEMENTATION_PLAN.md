# Analytics Phase 2: Implementation Plan

> **Source design doc:** `ANALYTICS-02.md`

> **IMPORTANT — Rules for modifying this file during build iterations:**
> - Check off completed items (`[ ]` -> `[x]`)
> - Append learnings under `> **Learnings:**` blocks
> - Add discovered work items where appropriate
> - Clean out completed items when the file gets large
> - Do NOT rewrite active (unchecked) items or change their design intent
> - Do NOT change the scope defined by the source document
> - This file tracks implementation progress; the source document and specs/ define scope

> **Scope guards:**
> - The `analytics_events` write path is NOT waste — Phase 3 builds read endpoints for it. Do NOT delete or modify the existing write path (buffer service, track() calls, event emission sites).
> - `isCompanyProfile` for UD4 is intentionally deferred — no backing field in User schema, needs spec decision.

> **Deployment note:** Phase A items span two repos (cryptoli + cryptoi-admin). For F1, ship the dashboard header change before the backend guard — sending an extra header to an unguarded endpoint is harmless; the reverse breaks the dashboard health check.

> **Phase dependencies:** Phases 1-2 (fixes) and Phases 3-4 (admin intelligence) are independent of each other. Within Phase 3, B2 depends on B2-prereq. Phase 4 items B1/B2/B3-component depend on their Phase 3 backend endpoints; all other Phase 4 items (B4-B9) have zero backend dependencies.

## Phase 1: Backend Fixes

Security and data-integrity fixes in the cryptoli backend. Priority-ordered by severity.

- [x] **F1:** Add `@UseGuards(AnalyticsGuard)` to the health endpoint in `src/analytics/analytics.controller.ts:73` — this is the only analytics read endpoint without auth. See deployment note above
  - Required tests: e2e test for `GET /analytics/health` returns 401 without API key; returns health payload with valid API key; update existing health e2e test that expects 200 without auth
  > **Learnings:** Single-line change in controller + unit test for guard metadata + e2e tests for 401/200. The test-analytics-key value comes from env in setup-app.ts.

- [x] **F2:** Replace error leakage in latest-members catch block — always return generic error message, log actual error with Logger
  > **Learnings:** Added Logger to controller, replaced conditional e.message with constant string. Also added e2e tests for latest-members endpoint (auth + success + error shape).

- [x] **Bug:** Add missing `country` argument (`analyticsCtx.country`) as 4th arg to `track()` calls in users.service.ts for user_follow and user_unfollow
  > **Learnings:** Only users.service.ts was missing the 4th arg; all other services (reviews, comments, complaints, search) already had it.

- [x] **F5:** Add GeoIP country fallback in auth.service.ts — `data.country = meta.country || geoResult?.country || null`
  > **Learnings:** geoResult was already computed two lines above; just needed to chain it in the fallback.

- [x] **UD4:** Include `userAgent` from latest session in admin user detail response
  > **Learnings:** Required adding userAgent to both the session select block and the response object.

- [x] **B5-fix:** Fix `lastActive` in admin user list — use `u.updatedAt` instead of hardcoded `'-'`
  > **Learnings:** Required adding updatedAt to the user select block as well.

## Phase 2: Dashboard Fixes

Render backend data that is already returned but not displayed in `cryptoi-admin`. Zero backend changes. Priority-ordered by user impact.

- [x] **F1-dashboard:** Add `X-Analytics-Key` header to `checkAnalyticsHealth()` in cryptoi-admin
  > **Learnings:** 3-line change matching existing fetchAnalyticsStats pattern. getAnalyticsApiKey() already imported.

- [x] **UD3:** Render discussions section in user detail page — added full section with status styles, empty state, and commentCount/date metadata

- [x] **UD1:** Render username, registrationCountry, country, moderatedAt in user detail page

- [x] **DS1:** Add stat cards for totalReviews, newThisWeek, totalRatings to main dashboard

- [x] **UD2:** Add createdAt dates to reviews and complaints in user detail page

- [x] **UL1:** Add joinedAt column to user list table + UserTableRow component

- [x] **SL1:** Render userAgent column in user sessions subpage (truncated with title tooltip)

- [x] **CL1:** Add createdAt column to complaints list table

## Phase 3: Admin Intelligence — Backend

New read endpoints for the `analytics_events` table and notification analytics. See source design doc section 3 Phase B (B-I) for full scope and architecture. The `(eventType, createdAt)` composite index covers all query patterns. Cache responses for 1 minute.

- [x] **B1:** Event aggregation endpoint — service method + controller route in the analytics module. GroupBy eventType with daily timeseries and dimensional breakdowns (by country, device, browser, os, path, referrer, UTM) querying `analytics_events` columns. See source design doc for full scope
  - Required tests: unit tests for service aggregation logic; e2e tests for the endpoint with auth
  > **Learnings:** Used Prisma groupBy for all dimensional breakdowns (10 dimensions) and $queryRaw for daily timeseries (date_trunc not supported in Prisma groupBy). All 12 queries run in parallel via Promise.all. 1-minute in-memory cache per unique param set (matches statsCache pattern). Endpoint: GET /api/analytics/events?from=&to=&eventType= with AnalyticsGuard. Error handling follows latestMembers pattern (generic error message, Logger.error for actual). 5 unit tests (service) + 5 unit tests (controller) + 5 e2e tests added.

- [x] **B2-prereq:** Fix `src/notifications/push.service.ts` to set `pushedAt` on the Notification record after successful `webPush.sendNotification()` — the `pushedAt` field exists in schema (line 302) but is never written. Note: `sendToUser()` currently receives only `userId` and payload, not the notification ID — the call chain from `NotificationsService.createForUser()` needs adjustment to pass the notification ID through
  - Required tests: unit test verifying pushedAt is set after successful push delivery
  > **Learnings:** Added optional `notificationId` parameter to `sendToUser()` (backwards-compatible). After `Promise.allSettled`, if any push succeeded and notificationId was provided, fire-and-forget `prisma.notification.update({ pushedAt })`. `NotificationsService.createForUser()` now passes `notification.id` as 3rd arg. Added 3 unit tests to push.service.spec.ts (pushedAt set on success, not set on all-fail, not set without notificationId) and updated notifications.service.spec.ts assertion to verify notificationId passthrough.

- [x] **B2:** Notification analytics endpoint — service method + controller route. GroupBy notification type, read rate (% where `read: true`), push delivery rate (% where `pushedAt` is set). Depends on B2-prereq for accurate push delivery metrics
  - Required tests: unit tests for aggregation logic; e2e tests for the endpoint with auth
  > **Learnings:** Used single `$queryRaw` with PostgreSQL `FILTER (WHERE ...)` for efficient per-type read/pushed counts in one query. Table name is `"Notification"` (PascalCase, no @@map) with camelCase columns (`"createdAt"`, `"pushedAt"`). Rates computed as percentages rounded to 2 decimal places. 1-minute in-memory cache per unique date range (same pattern as eventAggregationCache). Endpoint: `GET /api/analytics/notifications?from=&to=` with AnalyticsGuard. E2E tests need unique date ranges to avoid in-memory cache collisions between tests. Added 4 unit tests (service) + 4 unit tests (controller) + 5 e2e tests.

- [x] **B3:** Search query analytics endpoint — service method + controller route. Extract search queries from `analytics_events` where `eventType = 'search_performed'` using `prisma.$queryRaw` for JSONB `properties->>'query'` extraction
  - Required tests: unit tests for service logic; e2e tests for the endpoint with auth
  > **Learnings:** Used 5 parallel queries: count, daily timeseries (date_trunc raw SQL), top queries with per-query avg resultCount (JSONB `->>'query'` extraction + AVG), breakdown by search type (`->>'type'`), and overall avg resultCount. 1-minute in-memory cache per unique date range (same pattern as eventAggregationCache/notificationAnalyticsCache). Endpoint: `GET /api/analytics/search-queries?from=&to=` with AnalyticsGuard. Response includes `total`, `timeSeries`, `topQueries` (query + count + avgResultCount), `byType`, `avgResultCount`. Added 4 unit tests (service) + 4 unit tests (controller) + 5 e2e tests including real DB data seeding with JSONB properties.

## Phase 4: Admin Intelligence — Dashboard

Dashboard components for Phase 3 endpoints and rendering of already-fetched but unused analytics dimensions. All components follow the Dashboard Implementation Rules in source design doc section 3. Reference existing chart components as templates (listed in source doc).

> **Note:** The admin dashboard currently has zero page/component tests. New components in this phase should include component tests to begin closing this gap.

- [x] **B1-component:** Event aggregation dashboard component in `cryptoi-admin/app/dashboard/analytics/components/` — timeseries chart + dimensional breakdown tables. Add a new fetch function in `lib/analytics.ts` following the `fetchAnalyticsStats` pattern to call the B1 endpoint
  > **Learnings:** Added `fetchEventAggregation()` in `lib/analytics.ts` following exact `fetchAnalyticsStats` pattern (same error handling, cache, headers). Added `EventAggregationData` and `EventAggregationResult` types. Integrated into `getAnalyticsDashboardPayload()` as 5th parallel fetch in the `Promise.all`. Component `EventAggregationSection.tsx` (~268 lines) has 3 cards: timeseries line chart, event type horizontal bar chart with table, and dimensional breakdowns grid (9 dimensions using reusable `DimensionList` sub-component). Wrapped in `DeferredSection` for lazy loading. Placed after DeviceAndBrowser, before TopPages. Test file `tests/event-aggregation.test.ts` (6 tests) covers fetch success, eventType param, missing URL, HTTP error, network error, noCache option. Pre-existing TS errors in admin repo (Sentry module, user detail types) are unrelated.

- [x] **B4:** Funnel visualization component (signup -> purchase conversion) — data already in payload as `funnel`, `funnelByUtmSource`, `funnelByPath`. Zero backend changes
  > **Learnings:** `funnel`, `funnelByUtmSource`, `funnelByPath` were in payload but never destructured in AnalyticsDashboard. FunnelSection.tsx (~218 lines): main bar chart (3-step), two rate cards (signupCompletionRate, purchaseRate), and two breakdown tables (by UTM source, by landing path). Rates for breakdowns computed in-component. Wrapped in DeferredSection after OperationsSection.

- [x] **B5-chart:** OS distribution chart component — data already in payload as `byOs`, `osChartData`. Zero backend changes. Use PieChart pattern from `DeviceAndBrowserSection.tsx`
  > **Learnings:** OsDistributionSection.tsx (~87 lines): donut PieChart (innerRadius 60, outerRadius 100, paddingAngle 2) + visitors table. Follows exact DeviceAndBrowserSection browser donut pattern. Placed after DeviceAndBrowser section.

- [x] **B2-component:** Notification analytics dashboard component — add fetch function in `lib/analytics.ts` for B2 endpoint. Show notification type breakdown, read rates, push delivery rates
  > **Learnings:** Added `fetchNotificationAnalytics()` + `NotificationAnalyticsData` type. NotificationAnalyticsSection.tsx (~161 lines): 4 summary stat boxes (total, read count/rate, pushed count/rate), horizontal bar chart by type, and detailed table with per-type read/push rates. 3 tests for the fetch function. Endpoint: GET /api/analytics/notifications.

- [x] **B3-component:** Search query analytics dashboard component — add fetch function in `lib/analytics.ts` for B3 endpoint. Show top queries, query volume trends
  > **Learnings:** Added `fetchSearchQueryAnalytics()` + `SearchQueryAnalyticsData` type. SearchQueryAnalyticsSection.tsx (~182 lines): header badges (total searches, avg results), timeseries line chart, top queries table (query + count + avg results), search type breakdown list. 3 tests for the fetch function. Endpoint: GET /api/analytics/search-queries.

- [x] **B8:** Manual rollup trigger + system health operations panel — backend `POST /api/admin/analytics/rollup` and `GET /api/analytics/health` already exist. Surface rollup trigger button + health status (configured, connected, lastError, rollup.lastSuccessDate, rollup.stale). Note: health endpoint requires `X-Analytics-Key` after F1
  > **Learnings:** Enhanced `checkAnalyticsHealth()` to return full health data (configured, connected, lastError, rollup) — previously only read `json.enabled` and discarded the rest. Created `SystemHealthSection.tsx` ("use client") with 4 status dot cards + rollup trigger button. Added `triggerAnalyticsRollup()` in lib/admin-api.ts and API route at app/api/admin/analytics/rollup/route.ts using the `withAdminRoute` pattern. Rollup trigger POSTs to backend via admin axios (Bearer token auth).

- [x] **B7:** Activity timeline page for user detail — backend `GET /api/admin/users/:id/activity` already exists (returns paginated activity entries), create admin UI page at `cryptoi-admin/app/dashboard/users/[id]/activity/`. Follow the sessions subpage pattern
  > **Learnings:** Activity page at app/dashboard/users/[id]/activity/page.tsx (~125 lines) follows sessions subpage pattern exactly: server component, reads token from cookies, calls fetchUserActivity, renders paginated list with type badges (review/comment/complaint/vote/follow) and timestamps. Added fetchUserActivity + AdminActivityEntry type to lib/admin-api.ts. API route at app/api/admin/users/[id]/activity/route.ts. Added "Activity timeline →" link on user detail page next to the sessions link.

- [x] **B6:** Duration percentiles display — `durationP50Seconds` and `durationP95Seconds` already in payload (only `avgDuration` currently shown). Add to the existing duration display area
  > **Learnings:** Added P50/P95 as side-by-side progress bars in TrafficAndGoalsSection.tsx below avg duration. Only shows when either value > 0. Added durationP50Seconds and durationP95Seconds to the component's data prop type.

- [x] **B9:** Sales count + new members in range stat cards — `sales` and `newMembersInRange` already in payload (never destructured). Add to `OverviewCardsSection` or as a separate row
  > **Learnings:** Added `sales` and `newMembersInRange` props to OverviewCardsSection. Two new StatCards at the end of the grid. Data was already in payload but never destructured in AnalyticsDashboard — just needed to add to destructuring and pass as props.
