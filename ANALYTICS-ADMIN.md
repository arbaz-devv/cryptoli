# Analytics–Admin Dashboard Gap Analysis

> **Date:** 2026-03-29
> **Baseline:** PR #4 (`7cb34e0 feat(analytics): durable user intelligence platform with GDPR compliance`)
> **Purpose:** Identify backend data and capabilities that exist but are not yet surfaced in the admin dashboard.

---

## What PR #4 Added

PR #4 was 96 files, +10,453/−906 lines. It introduced:

| Category | What was added |
|----------|---------------|
| **DB tables** | `analytics_events` (raw event log, no FK to User) + `analytics_daily_summaries` (rolled-up EAV) |
| **Session enrichment** | 9 new fields: `ip`, `ipHash`, `userAgent`, `device`, `browser`, `os`, `country`, `timezone`, `trigger` |
| **User enrichment** | `registrationIp`, `registrationCountry` |
| **Services** | `AnalyticsBufferService` (in-memory → PG flush), `AnalyticsRollupService` (hourly Redis → PG), `GeoipService` (MaxMind local) |
| **Server-side tracking** | 14 event types across 7 modules (auth, reviews, comments, complaints, users, search, analytics) |
| **Admin endpoints** | `GET /admin/users/:id/sessions`, `GET /admin/users/:id/sessions/export`, `GET /admin/users/:id/activity`, `POST /admin/analytics/rollup` |
| **Analytics endpoints** | `GET /analytics/stats`, `GET /analytics/realtime`, `GET /analytics/latest-members`, `GET /analytics/health` (all behind `AnalyticsGuard`) |
| **Background jobs** | Hourly retention computation, hourly GDPR 90-day anonymization, hourly Redis→PG rollup |
| **GDPR compliance** | Opt-in consent gate, IP hashing (SHA-256), 90-day userId nullification, bot filtering, account deletion hook |

---

## Current Admin Endpoint Inventory

All in `src/admin/admin.controller.ts` behind `AdminGuard` unless noted.

| # | Method | Route | Purpose |
|---|--------|-------|---------|
| 1 | `POST` | `/admin/auth/login` | Admin JWT login (rate-limited 5/60s) |
| 2 | `POST` | `/admin/auth/config` | Check if admin login is configured |
| 3 | `GET` | `/admin/stats` | 8 platform-wide counters (totalUsers, activeToday, pendingReviews, flaggedContent, totalRatings, newThisWeek, totalReviews, openComplaints) |
| 4 | `GET` | `/admin/users` | Paginated user list with search/filter |
| 5 | `GET` | `/admin/users/:id` | Full user detail (profile, sessions, metrics, activity series) |
| 6 | `GET` | `/admin/users/:id/sessions` | Paginated session history |
| 7 | `GET` | `/admin/users/:id/sessions/export` | CSV/JSON session export |
| 8 | `GET` | `/admin/users/:id/activity` | Unified activity timeline |
| 9 | `PATCH` | `/admin/users/:id/status` | Suspend or restore user |
| 10 | `GET` | `/admin/complaints` | Paginated complaint list with search/filter |
| 11 | `GET` | `/admin/complaints/:id` | Complaint detail with replies |
| 12 | `PATCH` | `/admin/complaints/:id` | Update complaint status |
| 13 | `GET` | `/admin/reviews` | Paginated review list with search/filter |
| 14 | `GET` | `/admin/reviews/:id` | Review detail with comments, votes, reactions |
| 15 | `PATCH` | `/admin/reviews/:id` | Update review status |
| 16 | `GET` | `/admin/ratings` | Product ratings overview |
| 17 | `POST` | `/admin/analytics/rollup` | Trigger manual analytics rollup |
| 18 | `POST` | `/complaints/:id/reply` | Admin reply on complaint (in ComplaintsController) |

---

## Gap Analysis

### Gap 1 — Rich Analytics Locked Behind Separate Auth

`GET /api/analytics/stats` returns 30+ dimensions of insight but uses `AnalyticsGuard` (`X-Analytics-Key`), **not** `AdminGuard`. The admin's own `GET /api/admin/stats` returns only 8 basic DB counts.

**Data available in analytics but invisible to admin:**

| Metric | Source |
|--------|--------|
| Traffic timeseries (daily pageviews + uniques) | `AnalyticsService.getStats()` → `timeSeries` |
| Geographic breakdown (country distribution) | `byCountry` |
| Device / Browser / OS breakdown | `byDevice`, `byBrowser`, `byOs` |
| Referrer attribution | `byReferrer` (top 15 + "other") |
| UTM campaign attribution | `byUtmSource`, `byUtmMedium`, `byUtmCampaign` |
| Hourly / weekday traffic patterns | `byHour`, `byWeekday`, `byHourTz` |
| Top pages | `topPages` (top 20 normalized paths) |
| Session duration (avg / P50 / P95) | `avgDurationSeconds`, `durationP50Seconds`, `durationP95Seconds` |
| Bounce rate | `totalBounces`, `bounceRate` |
| Conversion funnel | `funnel` (signup_started → signup_completed → purchase, with rates) |
| Funnel by UTM source | `funnelByUtmSource` (top 20) |
| Funnel by page path | `funnelByPath` (top 20) |
| Retention cohorts | `retention` (day1Pct, day7Pct, day30Pct) |
| Likes count | `likes` |
| New members in range | `newMembersInRange` |
| Realtime active visitors + by country | `AnalyticsService.getRealtime()` |
| Latest registered members | `GET /analytics/latest-members` |
| System health / rollup status | `GET /analytics/health` |

### Gap 2 — Server-Side Events Are Write-Only

14 event types flow into the `analytics_events` PostgreSQL table but **no endpoint queries this data**. The table is append-only with no read path.

| Event Type | Source Module | Properties Stored | Insight Potential |
|------------|-------------|-------------------|-------------------|
| `review_created` | `ReviewsService` | `reviewId`, `companyId` | Content creation velocity, per-company review rates |
| `comment_created` | `CommentsService` | `commentId`, `reviewId`, `postId`, `complaintId` | Engagement depth, discussion activity |
| `complaint_created` | `ComplaintsService` | `complaintId`, `companyId`, `productId` | Moderation load trends, per-company complaint rates |
| `vote_cast` | Reviews/Comments/Complaints | `targetId`, `voteType` | Voting patterns, community health signals |
| `search_performed` | `SearchService` | `query`, `type`, `resultCount` | Top search queries, zero-result detection, search quality |
| `user_login` | `AuthController` | `userId` | Login frequency, peak login times |
| `user_register` | `AuthController` | `userId` | Registration trends |
| `user_logout` | `AuthController` | `userId` | Session patterns |
| `password_change` | `AuthController` | `userId` | Security event monitoring |
| `user_follow` | `UsersService` | `targetUserId`, `targetUsername` | Social graph growth |
| `user_unfollow` | `UsersService` | `targetUserId`, `targetUsername` | Churn signals |

**Note:** Server-side events bypass Redis counters entirely (PG buffer only). They are not included in rollup aggregations and have no dedicated query path.

### Gap 3 — Data Models With Zero Admin Visibility

| Data | Schema Location | Current Admin Access | What's Missing |
|------|----------------|---------------------|----------------|
| **Notifications** (13 types, read/unread, push delivery) | `schema.prisma:290-307` | None | Volume, read rates, push delivery stats, per-user notification history |
| **CompanyFollow** relationships | `schema.prisma:334-343` | None | Company follow trends, most-followed companies |
| **Report** model (PENDING/REVIEWED/RESOLVED/DISMISSED) | `schema.prisma:427-436` | None | **Dead code** — model exists but no service reads or writes it |
| **Posts** | `schema.prisma:202-212` | Nested in user detail only | No platform-wide post listing, search, or moderation |
| **Media** uploads | `schema.prisma:257-265` | None | No media management, moderation, or storage insights |
| **Trending** content | `TrendingService` | None | Public endpoint exists but admin has no trending view |
| **Reactions** (LIKE/DISLIKE/LOVE/HELPFUL) | `schema.prisma:236-255` | Aggregated counts only | No per-type breakdown, no reaction trends |

### Gap 4 — Admin Dashboard Presentation Issues

| Issue | Location | Details |
|-------|----------|---------|
| `lastActive` always `'-'` in user list | `admin.service.ts:324` | Data exists in sessions but list view never queries it |
| `newFeedbacks` always `0` | `admin.service.ts:228` | Hardcoded — no feedback collection mechanism exists |
| `adminNotes` always `null` on complaints | `admin.service.ts:748` | Placeholder field — no persistence mechanism |
| No global comment management | — | Comments only visible nested inside review detail |
| No platform-level reaction analytics | — | Reaction model exists but CRUD not implemented |

---

## Prioritized Implementation Roadmap

### P0 — Low Effort, High Impact (proxy existing data through AdminGuard)

| Task | Effort | Impact |
|------|--------|--------|
| Proxy `analytics/stats` through `AdminController` | ~20 lines | Unlocks all 30+ analytics dimensions for admin dashboard |
| Proxy `analytics/realtime` through `AdminController` | ~10 lines | Live visitor count + country breakdown |
| Proxy `analytics/latest-members` through `AdminController` | ~10 lines | Dashboard widget for recent registrations |
| Proxy `analytics/health` through `AdminController` | ~10 lines | Rollup status visibility (admin already triggers rollups) |
| Fix `lastActive` in user list | ~15 lines | Meaningful activity indicator in user management |

### P1 — Medium Effort, High Impact (new aggregation queries)

| Task | Effort | Impact |
|------|--------|--------|
| Server-side event aggregation endpoint | ~150 lines | Query `analytics_events` for content creation rates, voting trends, auth patterns |
| Search query analytics | ~80 lines | Top queries, zero-result detection from `search_performed` events |
| Admin stats enrichment | ~30 lines | Add totalComments, totalVotes, totalFollows, totalSessions to `/admin/stats` |
| Notification analytics | ~100 lines | Volume by type, read rates, push delivery stats |

### P2 — Medium Effort, Moderate Impact (new admin CRUD)

| Task | Effort | Impact |
|------|--------|--------|
| Platform-wide comment management | ~120 lines | List, search, moderate comments independently of reviews |
| Post management for admins | ~100 lines | List, search, moderate user posts |
| Trending content admin view | ~50 lines | Admin insight into trending content |
| Company follow analytics | ~60 lines | Most-followed companies, follow trends |

### P3 — Higher Effort, Future Consideration

| Task | Effort | Impact |
|------|--------|--------|
| Implement Report model CRUD | ~200 lines | Content reporting workflow (currently dead code) |
| Admin notes on complaints | ~50 lines | Persist internal notes for moderation |
| Media management | ~150 lines | View, moderate uploaded media |
| Per-company/product analytics | ~200 lines | Aggregate events by company/product from `analytics_events` properties |
| Reaction CRUD and analytics | ~150 lines | Full reaction system beyond current vote models |

---

## Architecture Notes

### Auth Separation

The `AnalyticsGuard` (`X-Analytics-Key` / `ANALYTICS_API_KEY`) and `AdminGuard` (`X-Admin-Key` or admin JWT) are intentionally separate authentication mechanisms. The analytics endpoints were designed to also serve external monitoring tools. The P0 proxy approach preserves this separation — admin endpoints delegate to `AnalyticsService` internally, requiring only `AdminGuard` auth.

### Server-Side Event Query Strategy

Server-side events bypass Redis entirely and go to PG via `AnalyticsBufferService`. They are **not** rolled up into `AnalyticsDailySummary`. Any query endpoint for these events must hit the `analytics_events` table directly with appropriate indexes. The table already has indexes on `(eventType, createdAt)` and `userId`.

### GDPR Considerations

- `analytics_events.userId` is nullified after 90 days by automated anonymization
- Any new admin endpoint querying raw events must respect this — user attribution is only available for events < 90 days old
- The `ipHash` field (SHA-256) is stored but never raw IPs — safe to expose in admin views
