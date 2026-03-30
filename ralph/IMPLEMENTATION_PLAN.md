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

- [ ] **F1:** Add `@UseGuards(AnalyticsGuard)` to the health endpoint in `src/analytics/analytics.controller.ts:73` — this is the only analytics read endpoint without auth. See deployment note above
  - Required tests: e2e test for `GET /analytics/health` returns 401 without API key; returns health payload with valid API key; update existing health e2e test that expects 200 without auth

- [ ] **F2:** Replace error leakage in latest-members catch block (`src/analytics/analytics.controller.ts:142-146`) — change to always return generic `'Failed to fetch latest members'` error message instead of `e.message`; add `private readonly logger = new Logger(AnalyticsController.name)` and log actual error with stack trace
  - Required tests: e2e test for `GET /analytics/latest-members`; unit test verifying error path returns generic message and logs the actual error

- [ ] **Bug:** Add missing `country` argument (`analyticsCtx.country`) as 4th arg to `track()` calls in `src/users/users.service.ts` for `user_follow` (line ~160) and `user_unfollow` (line ~201), matching the pattern used in reviews/comments/complaints/search

- [ ] **F5:** Add GeoIP country fallback in `src/auth/auth.service.ts:263` — change `data.country = meta.country || null` to `data.country = meta.country || geoResult?.country || null`
  - Required tests: unit test verifying country falls back to geoResult?.country when meta.country is absent

- [ ] **UD4:** Include `userAgent` from latest session in admin user detail response (`src/admin/admin.service.ts` `getUserDetail()`) — the dashboard renders `user.userAgent` but the backend doesn't include it in the response
  - Required tests: unit test verifying userAgent is included in getUserDetail response

- [ ] **B5-fix:** Fix `lastActive` in admin user list (`src/admin/admin.service.ts:323`) — replace hardcoded `'-'` with a real date (e.g., `user.updatedAt`), matching how `getUserDetail()` computes it at lines ~394 and ~555
  - Required tests: unit test verifying lastActive returns a real date string, not `'-'`

## Phase 2: Dashboard Fixes

Render backend data that is already returned but not displayed in `cryptoi-admin`. Zero backend changes. Priority-ordered by user impact.

- [ ] **F1-dashboard:** Add `X-Analytics-Key` header to `checkAnalyticsHealth()` in `cryptoi-admin/lib/analytics.ts:104-141`, matching the pattern used in `fetchAnalyticsStats` and `fetchLatestMembers`. Deploy this BEFORE the backend F1 guard

- [ ] **UD3:** Render the discussions section in user detail page (`cryptoi-admin/app/dashboard/users/[id]/page.tsx`) — backend returns `discussions[]` with title, commentCount, status, createdAt but the entire section is unrendered (only a JSX comment exists at line ~318)

- [ ] **UD1:** Render missing fields in user detail page (`cryptoi-admin/app/dashboard/users/[id]/page.tsx`): `username`, `registrationCountry`, `country`, `moderatedAt` — backend returns all four, dashboard doesn't display them

- [ ] **DS1:** Add stat cards for `totalReviews`, `newThisWeek`, `totalRatings` to the main dashboard (`cryptoi-admin/app/dashboard/page.tsx`) — backend already returns these in AdminStats, no stat cards render them. Add entries to the `statCards` array using existing `<StatCard>` component

- [ ] **UD2:** Add `createdAt` date columns to reviews and complaints tables in user detail page (`cryptoi-admin/app/dashboard/users/[id]/page.tsx`) — both `reviews[].createdAt` and `complaints[].createdAt` exist in type definitions but aren't rendered

- [ ] **UL1:** Add `joinedAt` column to user list table (`cryptoi-admin/app/dashboard/users/page.tsx`) — `AdminUser.joinedAt` exists in type, no table column renders it

- [ ] **SL1:** Render `userAgent` column in user sessions subpage (`cryptoi-admin/app/dashboard/users/[id]/sessions/page.tsx`) — `AdminUserSession.userAgent` exists in type but not rendered (admin's own `/sessions` page already shows it as a reference)

- [ ] **CL1:** Add `createdAt` column to complaints list table (`cryptoi-admin/app/dashboard/complaints/page.tsx`) — `AdminComplaint.createdAt` exists in type, not rendered

## Phase 3: Admin Intelligence — Backend

New read endpoints for the `analytics_events` table and notification analytics. See source design doc section 3 Phase B (B-I) for full scope and architecture. The `(eventType, createdAt)` composite index covers all query patterns. Cache responses for 1 minute.

- [ ] **B1:** Event aggregation endpoint — service method + controller route in the analytics module. GroupBy eventType with daily timeseries and dimensional breakdowns (by country, device, browser, os, path, referrer, UTM) querying `analytics_events` columns. See source design doc for full scope
  - Required tests: unit tests for service aggregation logic; e2e tests for the endpoint with auth

- [ ] **B2-prereq:** Fix `src/notifications/push.service.ts` to set `pushedAt` on the Notification record after successful `webPush.sendNotification()` — the `pushedAt` field exists in schema (line 302) but is never written. Note: `sendToUser()` currently receives only `userId` and payload, not the notification ID — the call chain from `NotificationsService.createForUser()` needs adjustment to pass the notification ID through
  - Required tests: unit test verifying pushedAt is set after successful push delivery

- [ ] **B2:** Notification analytics endpoint — service method + controller route. GroupBy notification type, read rate (% where `read: true`), push delivery rate (% where `pushedAt` is set). Depends on B2-prereq for accurate push delivery metrics
  - Required tests: unit tests for aggregation logic; e2e tests for the endpoint with auth

- [ ] **B3:** Search query analytics endpoint — service method + controller route. Extract search queries from `analytics_events` where `eventType = 'search_performed'` using `prisma.$queryRaw` for JSONB `properties->>'query'` extraction
  - Required tests: unit tests for service logic; e2e tests for the endpoint with auth

## Phase 4: Admin Intelligence — Dashboard

Dashboard components for Phase 3 endpoints and rendering of already-fetched but unused analytics dimensions. All components follow the Dashboard Implementation Rules in source design doc section 3. Reference existing chart components as templates (listed in source doc).

> **Note:** The admin dashboard currently has zero page/component tests. New components in this phase should include component tests to begin closing this gap.

- [ ] **B1-component:** Event aggregation dashboard component in `cryptoi-admin/app/dashboard/analytics/components/` — timeseries chart + dimensional breakdown tables. Add a new fetch function in `lib/analytics.ts` following the `fetchAnalyticsStats` pattern to call the B1 endpoint

- [ ] **B4:** Funnel visualization component (signup -> purchase conversion) — data already in payload as `funnel`, `funnelByUtmSource`, `funnelByPath`. Zero backend changes

- [ ] **B5-chart:** OS distribution chart component — data already in payload as `byOs`, `osChartData`. Zero backend changes. Use PieChart pattern from `DeviceAndBrowserSection.tsx`

- [ ] **B2-component:** Notification analytics dashboard component — add fetch function in `lib/analytics.ts` for B2 endpoint. Show notification type breakdown, read rates, push delivery rates

- [ ] **B3-component:** Search query analytics dashboard component — add fetch function in `lib/analytics.ts` for B3 endpoint. Show top queries, query volume trends

- [ ] **B8:** Manual rollup trigger + system health operations panel — backend `POST /api/admin/analytics/rollup` and `GET /api/analytics/health` already exist. Surface rollup trigger button + health status (configured, connected, lastError, rollup.lastSuccessDate, rollup.stale). Note: health endpoint requires `X-Analytics-Key` after F1

- [ ] **B7:** Activity timeline page for user detail — backend `GET /api/admin/users/:id/activity` already exists (returns paginated activity entries), create admin UI page at `cryptoi-admin/app/dashboard/users/[id]/activity/`. Follow the sessions subpage pattern

- [ ] **B6:** Duration percentiles display — `durationP50Seconds` and `durationP95Seconds` already in payload (only `avgDuration` currently shown). Add to the existing duration display area

- [ ] **B9:** Sales count + new members in range stat cards — `sales` and `newMembersInRange` already in payload (never destructured). Add to `OverviewCardsSection` or as a separate row
