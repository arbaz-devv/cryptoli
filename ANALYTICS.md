# Analytics System Architecture

> Design for expanding Cryptoli's analytics from a Redis-only ephemeral
> system to a durable, queryable user intelligence platform.

## Table of Contents

- [Current State](#current-state)
- [Design Goals](#design-goals)
- [Architecture Overview](#architecture-overview)
- [Data Flow](#data-flow)
- [Data Model](#data-model)
- [Service Architecture](#service-architecture)
- [Admin Integration](#admin-integration)
- [Frontend Changes](#frontend-changes)
- [Redis Scaling Fixes](#redis-scaling-fixes)
- [GDPR Compliance](#gdpr-compliance)
- [Implementation Phases](#implementation-phases)
- [Appendix: Scaling Analysis](#appendix-scaling-analysis)

---

## Current State

### What Exists

| Layer | Role | Details |
|-------|------|---------|
| **Frontend** (`cryptoli-frontend`) | Event producer | `AnalyticsTracker.tsx` sends `page_view`, `page_leave`, `signup_started`, `signup_completed` via `POST /api/analytics/track`. Defines but never emits `purchase` or `like`. Uses `sendBeacon` for page_leave, `fetch+keepalive` for others. No `credentials: "include"` — auth cookies are NOT sent. Cookie consent gate (`analytics_consent` cookie). Session ID in localStorage. |
| **Backend** (`cryptoli`) | Redis-only storage | `AnalyticsService.track()` writes ~34-38 Redis commands per event (15 data + 15 EXPIRE + extras for cohort/realtime). Uses `Promise.all` with individual awaits, not `redis.pipeline()`. 32-day TTL. Fire-and-forget. No PostgreSQL analytics tables. `resolveCountry()` falls back to external `ipwho.is` API on geoip-lite miss (GDPR concern). Consent check `=== false` treats undefined as consent (GDPR concern). Bot traffic counted as real page views (no `isBot()` filtering). |
| **Admin** (`cryptoi-admin`) | Read-only dashboards | `/dashboard/analytics` reads site-wide stats via `GET /api/analytics/stats` (max 90-day range). Polls `/api/analytics/realtime` every 30s. `/dashboard/users/[id]` shows per-user detail — admin page is **ready** to render device/browser/OS/country/timezone/IP fields but backend returns no data for them. No per-user session history page. No download/export capability. |

### What's Missing

| Gap | Impact |
|-----|--------|
| Data expires after 32 days | No historical analysis beyond Redis TTL window |
| No user-linked events | Can't answer "what did user X do?" |
| No server-side action tracking | Reviews, votes, follows, comments invisible to analytics |
| No raw event log | Can't drill down, replay, or run ad-hoc queries |
| Backend returns no device/country/IP/browser/OS/timezone for users | `activitySeries` hardcodes `device: "Unknown"`, `country: "Unknown"`; IP/browser/OS/timezone are absent entirely |
| Session model has no context fields | Only stores id, userId, token, expiresAt, createdAt |
| `resolveCountry()` calls external `ipwho.is` | Undisclosed third-party data transfer (GDPR); 100-500ms blocking on cache miss |
| Consent check treats undefined as consent | `if (body.consent === false)` lets undefined through — GDPR requires opt-in |
| Bot traffic inflates analytics | No `isBot()` check — Googlebot, Bingbot, GPTBot counted as real visitors |
| geoip-lite database never updated | No MaxMind license key, no update script — accuracy degrades silently |
| `@types/ua-parser-js@0.7.39` doesn't match `ua-parser-js@2.0.9` | Type safety bypassed via `require()` cast; v2 ships its own types |
| `normalizeIp`/`isPrivateOrLocalIp` duplicated | Identical code in both analytics.controller.ts and analytics.service.ts |
| No per-user session history in admin | Client requires: "link to a specific page and download option for the data" |
| `X-Analytics-Key` missing from CORS `allowedHeaders` | Browser-based admin dashboard gets CORS preflight failures on stats/realtime |

### Three-Repo Relationship

```
Frontend (cryptoli-frontend)
  - ONLY event producer (client-side tracking)
  - Sends: path, UA, timezone, sessionId, UTM, referrer, consent, enteredAt/leftAt
  - Does NOT send auth cookies (no credentials: "include")
  - Never sends userId in the analytics payload

Admin (cryptoi-admin)
  - Read-only consumer
  - /dashboard/analytics: site-wide stats from GET /api/analytics/stats,realtime
  - /dashboard/users/[id]: per-user detail from GET /api/admin/users/:id
  - Polls /api/analytics/realtime every 30 seconds
  - User detail page renders device/browser/OS/country/timezone/IP fields
    but displays "—" because backend returns no values
  - NEVER writes tracking data
  - No per-user session history page exists
  - No download/export capability exists

Backend (cryptoli)
  - Stores everything in Redis (zero PG analytics tables)
  - Zero server-side activity tracking (no other module imports AnalyticsModule)
  - AnalyticsService injects only RedisService (no PrismaService)
  - AnalyticsController injects PrismaService for User.count() in stats endpoint
  - normalizeIp and isPrivateOrLocalIp duplicated between controller and service
  - AuthController.login()/register() lack @Req() — no access to request metadata
  - CORS allowedHeaders missing X-Analytics-Key
```

---

## Design Goals

1. Track everything about users **externally** (IP, device, browser, OS, timezone,
   country, referrer) — per session, per action.
2. Track everything about users **internally** (all activity: reviews, votes,
   follows, comments, logins, searches, profile updates).
3. Keep Redis as the fast/hot layer for real-time site-wide analytics (unchanged).
4. Add PostgreSQL persistence for durable storage, per-user drill-down, historical
   queries, and data preservation beyond the 32-day Redis TTL.
5. Feed the admin's per-user detail page with real data instead of "—".
6. Provide per-user session history page with download/export in admin.
7. Comply with GDPR (hash IPs, 90-day identified retention, consent-based).

---

## Architecture Overview

> This diagram shows the **proposed** state after all phases are implemented.
> Items marked `[NEW]` do not exist yet.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                       │
│  AnalyticsTracker.tsx ─── POST /api/analytics/track ──────────────────┐     │
│  (page_view, page_leave, signup_*, like)                              │     │
│  [NEW] + credentials: "include" (sends auth cookies)                  │     │
│  [NEW] + fetch+keepalive only (replaces sendBeacon for page_leave)    │     │
│                                                                       │     │
│  [NEW] CookieConsent v2 ─── analytics_consent_v2 cookie               │     │
└───────────────────────────────────────────────────────────────────────┼─────┘
                                                                        │
┌───────────────────────────────────────────────────────────────────────▼─────┐
│                              BACKEND                                        │
│                                                                             │
│  AnalyticsController.track()                                                │
│    ├── [NEW] isBot() check — skip tracking for bots                        │
│    ├── extract IP, UA, country from headers (via AnalyticsInterceptor)      │
│    ├── [NEW] extract userId from auth cookie (when authenticated)           │
│    │                                                                        │
│    └──► AnalyticsService.track(ip, ua, body, countryHint, serverCtx?)       │
│           │                                                                 │
│           ├──► [NEW] Redis pipeline (single round-trip for all commands)    │
│           │     INCR, HINCRBY, PFADD, ZADD                                 │
│           │     32-day TTL, real-time aggregates                            │
│           │                                                                 │
│           └──► [NEW] AnalyticsBufferService.push(event)                     │
│                  │  synchronous, fire-and-forget                            │
│                  │  in-memory buffer (max 2000, drop + log on overflow)     │
│                  │                                                          │
│                  └── flush every 2s / 500 rows ──► PostgreSQL               │
│                       prisma.analyticsEvent.createMany()                    │
│                                                                             │
│  [NEW] Server-side event emitters (via AnalyticsInterceptor):               │
│    AuthController ──► track("user_login" / "user_register" / "user_logout") │
│    ReviewsService ──► track("review_created" / "vote_cast")                 │
│    CommentsService ──► track("comment_created" / "vote_cast")               │
│    ComplaintsService ──► track("complaint_created" / "vote_cast")           │
│    UsersService ──► track("user_follow" / "user_unfollow")                  │
│    SearchService ──► track("search_performed")                              │
│                                                                             │
│  [NEW] AuthService.createSession() ── NOW CAPTURES:                         │
│    ip, ipHash, userAgent, device, browser, os, country, timezone, trigger   │
│                                                                             │
│  [NEW] AnalyticsRollupService (setInterval hourly check):                   │
│    Redis keys (yesterday) ──► AnalyticsDailySummary table                   │
│    Safety net: also checks day-before-yesterday                             │
│                                                                             │
│  [NEW] AnalyticsService.getStats() ── HYBRID READER:                        │
│    days < 28 days ago ──► Redis (unchanged)                                 │
│    days >= 28 days ago ──► PostgreSQL (AnalyticsDailySummary)               │
│    merge + return unified AnalyticsStats                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                          │                        │
              ┌───────────▼──────────┐    ┌───────▼────────────────┐
              │       REDIS          │    │    POSTGRESQL           │
              │                      │    │                         │
              │  analytics:* keys    │    │  Session (extended)     │
              │  32-day TTL          │    │    + ip, ipHash, trigger│
              │  Real-time counters  │    │    + userAgent, device  │
              │  HLL uniques         │    │    + browser, os        │
              │  Sorted set active   │    │    + country, timezone  │
              │                      │    │                         │
              │  (now pipelined,     │    │  [NEW] AnalyticsEvent   │
              │   bot-filtered)      │    │    raw event log        │
              │                      │    │                         │
              └──────────────────────┘    │  [NEW] DailySummary     │
                                          │    permanent aggregates │
              ┌───────────────────────┐   │                         │
              │       ADMIN           │   │  User (extended)        │
              │                       │   │    + registrationIp     │
              │  /dashboard/analytics │   │    + registrationCountry│
              │    reads stats+real-  │   │                         │
              │    time; hybrid read  │   └─────────────────────────┘
              │    for historical     │
              │                       │
              │  /dashboard/users/[id]│
              │    REAL device/country│
              │    [NEW] session link │
              │                       │
              │  [NEW] /users/[id]/   │
              │    sessions           │
              │    history + export   │
              └───────────────────────┘
```

---

## Data Flow

### Write Path: Frontend Event

```
POST /api/analytics/track
  │  body: { path, device(UA), timezone, event, sessionId, consent, ... }
  │  cookies: auth JWT (HttpOnly)   ← requires credentials: "include"
  │
  ▼
AnalyticsInterceptor
  │  attaches req.analyticsCtx = { clientIp, countryHint, userAgent }
  │
  ▼
AnalyticsController.track()
  │  isBot(userAgent) → skip tracking if true
  │  req.user?.userId → from auth cookie (if authenticated)
  │
  ▼
AnalyticsService.track(ip, ua, body, countryHint, serverCtx?)
  │  if (!body.consent) return;    ← consent gate (explicit opt-in)
  │  if (isBot(ua)) return;        ← bot filter (ua-parser-js/bot-detection)
  │  resolveCountry(ip)           ← geoip-lite only (no external API)
  │  getDeviceAndBrowser(ua)      ← ua-parser-js
  │
  ├──► redis.pipeline()           ← single round-trip for all commands
  │      INCR   analytics:pageviews:{day}
  │      PFADD  analytics:hll:uniques:{day}
  │      PFADD  analytics:hll:sessions:{day}
  │      HINCRBY analytics:country:{day} {code}
  │      HINCRBY analytics:device:{day} {type}
  │      HINCRBY analytics:browser:{day} {name}
  │      HINCRBY analytics:os:{day} {name}
  │      HINCRBY analytics:referrer:{day} {host}
  │      HINCRBY analytics:utm_source:{day} {src}
  │      HINCRBY analytics:hour:{day} {h}
  │      HINCRBY analytics:weekday:{day} {wd}
  │      HINCRBY analytics:path:{day} {path}
  │      ZADD   analytics:recent_sessions {ts} {member}
  │      SET    analytics:first_visit:{sessionId} NX
  │      SADD   analytics:cohort:{day} {sessionId} (idempotent)
  │      ... (EXPIRE paired with each write)
  │      pipeline.exec()          ← ~38 commands, 1 TCP roundtrip
  │
  └──► bufferService.push({
         eventType, sessionId, userId, ipHash, country,
         device, browser, os, path, referrer, utm_*,
         durationSeconds, properties, createdAt
       })
         │  synchronous, returns void
         │  buffer: in-memory array, max 2000 events
         │
         └── [every 2s or 500 rows] flush()
               prisma.analyticsEvent.createMany(batch)
               SET LOCAL synchronous_commit = off
```

### Write Path: Server-side Event

```
ReviewsController.create()
  │  req.analyticsCtx populated by AnalyticsInterceptor
  │  authorId from req.user
  │
  ▼
ReviewsService.create(body, authorId, analyticsCtx?)
  │  prisma.review.create(...)
  │  socketService.emitReviewCreated(review)
  │
  └──► analyticsService.track(ctx.ip, ctx.ua, {}, undefined, {
         eventType: 'review_created',
         userId: authorId,
         entityId: review.id,
         entityType: 'review',
         meta: { companyId, overallScore }
       })
         ├──► Redis: HINCRBY analytics:funnel:event:{day} review_created 1
         └──► Buffer → PostgreSQL analytics_events
```

### Read Path: Site-Wide Stats (Hybrid)

```
GET /api/analytics/stats?from=2025-12-01&to=2026-03-23
  │
  ▼
AnalyticsService.getStats(from, to)
  │
  │  cutoff = today - 28 days (4-day buffer vs 32-day Redis TTL)
  │
  ├── recentDays (>= cutoff)
  │     └──► Redis: 22-key-per-day read loop (existing, unchanged)
  │
  ├── historicalDays (< cutoff)
  │     └──► PostgreSQL: SELECT * FROM analytics_daily_summaries
  │           WHERE date BETWEEN ... AND ...
  │
  └── mergePartialStats(pgStats, redisStats)
        │  25 of 30 fields: simple additive (counts, maps)
        │  avgDuration: weighted merge (sum/count)
        │  percentiles: merge histogram buckets, recompute
        │  uniques: sum per-day PFCOUNT (accept ~3% boundary overcount)
        │  retention: compute from analytics_events SQL (cross-day)
        └──► return unified AnalyticsStats
```

### Read Path: Per-User Detail

```
GET /api/admin/users/:id
  │
  ▼
AdminService.getUserDetail(id)
  │
  ├── prisma.user.findUnique(id)           → profile, registrationIp, registrationCountry
  ├── prisma.session.findMany(userId)      → sessions with ip, device, country, ...
  ├── prisma.comment.count(authorId)       → comment count
  ├── prisma.helpfulVote.count(userId)     → vote counts
  ├── prisma.review.findMany(authorId)     → recent reviews
  ├── prisma.complaint.findMany(authorId)  → recent complaints
  │
  └── Derive from real session data:
        lastLoginIp     = mostRecentSession.ip
        registrationIp  = user.registrationIp ?? earliestSession.ip
        device          = mostRecentSession.device
        browser         = mostRecentSession.browser
        os              = mostRecentSession.os
        country         = mostRecentSession.country
        timezone        = mostRecentSession.timezone
        loginCount      = sessions.length
        activitySeries[].devices  = Record<string, number> per day
        activitySeries[].countries = Record<string, number> per day
```

---

## Data Model

### Session Model (Extended)

All new fields are nullable for backward compatibility with existing rows.

```prisma
model Session {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  token     String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())

  // NEW — request context captured at login/register/password-change
  ip        String?  @db.VarChar(45)   // max IPv6 length
  ipHash    String?  @db.Char(64)      // SHA-256 hex (no salt — deterministic for correlation)
  userAgent String?  @db.VarChar(512)
  device    String?  @db.VarChar(16)   // desktop | mobile | tablet
  browser   String?  @db.VarChar(64)
  os        String?  @db.VarChar(64)
  country   String?  @db.Char(2)       // ISO 3166-1 alpha-2
  timezone  String?  @db.VarChar(64)   // IANA tz string (from geoip-lite or client)
  trigger   String?  @db.VarChar(20)   // login | register | password_change

  @@index([userId])
  @@index([createdAt])
}
```

**`trigger` field:** Distinguishes how the session was created. All three
session-creation points (`login`, `register`, `changePassword`) pass this
value. Useful for security auditing and understanding registration vs
login patterns.

**`ipHash` without salt:** Intentional. The hash serves two purposes:
correlation (same IP across sessions and analytics events) and privacy
(AnalyticsEvent stores only the hash, never raw IP). A salted hash would
defeat correlation. The Session table stores raw IP for admin visibility
(disclosed in privacy policy).

### User Model (Extended)

Add after `subscription` field, before `createdAt`. Only fields that cannot
be reliably derived from sessions — if sessions are pruned/expired, the
earliest session data is lost.

```prisma
  registrationIp      String?   @map("registration_ip")      @db.VarChar(45)
  registrationCountry String?   @map("registration_country") @db.Char(2)
```

> **Not added:** `lastLoginAt`, `lastLoginIp`, `loginCount` — always
> derivable from enriched Session table. Admin's `getUserDetail()` already
> queries sessions and derives `lastLoginAt` from the most recent one.

### AnalyticsEvent (New — Append-Only Event Log)

No FK to User — avoids cascade risk on a high-write table. Matches the
existing `Report` model pattern (plain string IDs, no relations).

```prisma
model AnalyticsEvent {
  id              String   @id @default(cuid())
  eventType       String   @map("event_type")

  // Identity (no FK constraints)
  sessionId       String?  @map("session_id") @db.VarChar(128)
  userId          String?  @map("user_id")

  // Request context
  ipHash          String?  @map("ip_hash") @db.Char(64)
  country         String?  @db.Char(2)
  device          String?  @db.VarChar(16)
  browser         String?  @db.VarChar(64)
  os              String?  @db.VarChar(64)
  timezone        String?  @db.VarChar(64)

  // Page/navigation
  path            String?  @db.VarChar(512)
  referrer        String?  @db.VarChar(128)
  utmSource       String?  @map("utm_source") @db.VarChar(80)
  utmMedium       String?  @map("utm_medium") @db.VarChar(80)
  utmCampaign     String?  @map("utm_campaign") @db.VarChar(80)
  durationSeconds Int?     @map("duration_seconds")

  // Event-specific metadata
  properties      Json?    @default("{}")

  createdAt       DateTime @default(now()) @map("created_at")

  @@index([userId])
  @@index([eventType, createdAt])
  @@index([createdAt])

  @@map("analytics_events")
}
```

### AnalyticsDailySummary (New — Permanent Aggregates)

EAV (Entity-Attribute-Value) single-table design. Each row represents one
`(date, dimension, dimensionValue)` triple with a count. Scalar metrics use
`dimension = '_total_'`. Populated by the nightly rollup service before
Redis keys expire.

```prisma
model AnalyticsDailySummary {
  id              String   @id @default(cuid())
  date            DateTime @db.Date
  dimension       String                // '_total_', 'country', 'device', etc.
  dimensionValue  String   @map("dimension_value") @db.VarChar(128)
  count           Int

  createdAt       DateTime @default(now()) @map("created_at")

  @@unique([date, dimension, dimensionValue])
  @@index([date])
  @@index([dimension, date])

  @@map("analytics_daily_summaries")
}
```

**Row budget:** ~100-300 rows/day (~110K rows/year). Scalar counters:
`_total_/pageviews`, `_total_/bounces`, `_total_/duration_sum`,
`_total_/duration_count`, `_total_/likes`, `_total_/uniques_approx`,
`_total_/sessions_approx`. Dimension breakdowns: `country/US`,
`device/desktop`, `browser/chrome`, `hour/14`, `duration_bucket/0_9`,
`funnel_event/signup_started`, `funnel_by_source/google|signup_started`, etc.

**Why EAV over dedicated columns:** Flexible for new dimensions without
migration. Single `createMany()` per day. The `getStats()` reconstruction
loop already works with flat maps.

**Uniques storage:** Stores per-day PFCOUNT integer (not HLL binary).
Cross-day unique counts from DailySummary slightly overcount (~3% at
boundary) because sessions spanning multiple days are counted in each.
Acceptable for historical data; within the 28-day Redis window, true HLL
union is used.

**Duration histograms:** Stored as dimension rows (`duration_bucket/0_9`,
`duration_bucket/10_29`, etc.). Mergeable across sources — add bucket
counts, recompute percentiles from combined histogram using existing
`approximateDurationPercentile()`.

**Retention:** NOT stored in DailySummary. Retention is forward-looking
(day+30 data doesn't exist at rollup time). Always computed fresh from
`analytics_events` table via SQL CTE or from Redis for the recent window.

### Storage Estimates

At ~300 events/min (current):

| Table | Rows/month | Size/year |
|-------|-----------|-----------|
| analytics_events | ~13M | ~70 GB |
| analytics_daily_summaries | ~6K-9K | ~30 MB |

---

## Service Architecture

### New Services

| Service | File | Responsibility | Scheduling |
|---------|------|---------------|------------|
| `AnalyticsBufferService` | `src/analytics/analytics-buffer.service.ts` | In-memory event buffer, batch flush to PG | `setInterval` (2s) |
| `AnalyticsRollupService` | `src/analytics/analytics-rollup.service.ts` | Redis daily keys → DailySummary in PG | `setInterval` (1h) |

### Shared Utilities

Extract when Phase 2 creates the second call site (AuthController needs
`getClientIp`/`getCountryHint`; AuthService needs `getDeviceAndBrowser`).

**Immediate dedup:** `normalizeIp` and `isPrivateOrLocalIp` are currently
duplicated between `analytics.controller.ts` (lines 25, 42) and
`analytics.service.ts` (lines 291, 312). Consolidate into `ip-utils.ts`.

| Utility | File | Contents |
|---------|------|----------|
| IP extraction | `src/analytics/ip-utils.ts` | `getClientIp`, `getCountryHint`, `normalizeIp`, `isPrivateOrLocalIp`, `pickBestIp`, `parseForwardedHeader`, `firstHeader` |
| UA parsing | `src/common/ua.ts` | `getDeviceAndBrowser` (extract from analytics.service.ts) |

### AnalyticsBufferService

```typescript
@Injectable()
export class AnalyticsBufferService implements OnModuleInit, OnModuleDestroy {
  private buffer: BufferedEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  FLUSH_INTERVAL_MS = 2_000;
  FLUSH_THRESHOLD = 500;
  MAX_BUFFER = 2_000;

  push(event: BufferedEvent): void    // synchronous, drops on overflow
  private async flush(): Promise<void> // splice then createMany
  onModuleInit()                       // starts setInterval
  async onModuleDestroy()              // drains buffer
}
```

- Uses `setInterval`, not `@nestjs/schedule` (internal heartbeat, not cron)
- Not exported from `AnalyticsModule` (internal implementation detail)
- `splice(0, length)` before `await` prevents race conditions
- On PG failure: logs error, does not re-queue (analytics loss acceptable)
- On graceful shutdown: `onModuleDestroy` drains buffer

### AnalyticsRollupService (~215 lines)

```typescript
@Injectable()
export class AnalyticsRollupService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  // Core methods
  async readDayFromRedis(day: string): Promise<DaySnapshot>
  async rollupDay(day: string): Promise<boolean>
  private async checkAndRollup(): Promise<void>

  // Lifecycle
  onModuleInit()     // starts setInterval(1h) + initial check after 10s delay
  onModuleDestroy()  // clears interval
}
```

**Rollup flow:**
1. Hourly `checkAndRollup()` checks yesterday and day-before-yesterday
2. `rollupDay(day)` — idempotent with 3 layers of protection:
   - PostgreSQL check: `findFirst({ where: { date, dimension: '_total_' } })`
   - Redis NX lock: `SET analytics:rollup:last:{day} 1 EX 172800 NX`
   - PostgreSQL unique constraint: catches race conditions
3. `readDayFromRedis(day)` — extracted from `getStats()` per-day read loop
   (same 22 Redis keys), returns a `DaySnapshot` struct
4. Writes rows via `prisma.analyticsDailySummary.createMany()`
5. Logs success/failure, stores `analytics:rollup:last_success` in Redis

**Why separate service:** `AnalyticsService` is 1,154 lines with only
`RedisService` injected. Rollup needs `PrismaService` and has its own
lifecycle (interval timer). Clean separation.

### AnalyticsInterceptor

Per-controller interceptor (not global) that extracts request context.

```typescript
// src/analytics/analytics.interceptor.ts
@Injectable()
export class AnalyticsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest();
    req.analyticsCtx = {
      clientIp: getClientIp(req),
      countryHint: getCountryHint(req),
      userAgent: req.headers['user-agent'] ?? '',
    };
    return next.handle();
  }
}
```

**Why per-controller, not global:** Only analytics controller and a handful
of feature controllers need request context. Running IP header parsing on
every route (including health, search, trending) is wasteful. Controllers
opt in via `@UseInterceptors(AnalyticsInterceptor)`.

**Why not socket-event tapping:** SocketService emits 7 event types after
DB writes, but socket events lack request context (IP, UA, country).
Per-service injection allows capturing the full request context.

### Request Context Propagation

```typescript
// src/analytics/analytics-context.ts
export interface AnalyticsContext {
  ip: string;
  userAgent: string;
  country?: string;
  userId?: string;
}
```

Services access `req.analyticsCtx` passed by controllers as an optional
trailing parameter. Controllers that need server-side tracking read
`req.analyticsCtx` from the interceptor.

### Server-Side Event Catalog

| Source | Event Type | Entity | Properties (JSONB) |
|--------|-----------|--------|-------------------|
| AuthController | `user_login` | — | `{ username }` |
| AuthController | `user_register` | — | `{ username }` |
| AuthController | `user_logout` | — | `{}` |
| AuthController | `password_change` | — | `{}` |
| ReviewsService | `review_created` | review | `{ companyId, score }` |
| ReviewsService | `vote_cast` | review | `{ voteType, action: "vote" }` |
| ReviewsService | `vote_cast` | review | `{ voteType: "UP", action: "helpful_toggle" }` |
| CommentsService | `comment_created` | comment | `{ targetType, targetId }` |
| CommentsService | `vote_cast` | comment | `{ voteType }` |
| ComplaintsService | `complaint_created` | complaint | `{ companyId }` |
| ComplaintsService | `vote_cast` | complaint | `{ voteType }` |
| UsersService | `user_follow` | user | `{ targetUserId }` |
| UsersService | `user_unfollow` | user | `{ targetUserId }` |
| SearchService | `search_performed` | — | `{ query, type, resultCount }` |

Events emitted **after** DB writes, **after** socket emissions, matching
the existing socket emit ordering convention.

**Implementation notes:**
- All controllers except SearchController already have `@Req()` on mutating
  endpoints. SearchController needs `@Req()` added.
- `ComplaintsService.vote()` returns `$transaction` directly (no
  post-transaction code). Must refactor to capture result, then track.
- `ComplaintsService` currently injects only `PrismaService`. Must also
  inject `AnalyticsService` when the module imports `AnalyticsModule`.
- All `analyticsCtx` params are optional (`?`) for backward compatibility.

### Module Registration Changes

| Module | Change |
|--------|--------|
| `AnalyticsModule` | Add `AnalyticsBufferService`, `AnalyticsRollupService`, `AnalyticsInterceptor` to providers |
| `AuthModule` | Import `AnalyticsModule` (no circular dep — Auth→Analytics is one-directional) |
| `ReviewsModule` | Import `AnalyticsModule` |
| `CommentsModule` | Import `AnalyticsModule` |
| `ComplaintsModule` | Import `AnalyticsModule` |
| `UsersModule` | Import `AnalyticsModule` |
| `SearchModule` | Import `AnalyticsModule` |
| `AdminModule` | Import `AnalyticsModule` (for rollup endpoint + health status) |

**No circular dependencies.** AnalyticsModule imports only PrismaModule
(global). All consumer→Analytics edges are one-directional. Verified
against the full dependency graph.

### Hybrid getStats() Merge Strategy

| Category | Fields | Strategy |
|----------|--------|----------|
| **Simple additive** | totalPageviews, totalBounces, likes, sales, byCountry, byDevice, byBrowser, byOs, byReferrer, byUtm*, byHour, byWeekday, byHourTz, topPages (raw), funnelEvents, funnelBySource, funnelByPath | `redis[k] + pg[k]` for each key |
| **Weighted** | avgDurationSeconds | `(redisSum + pgSum) / (redisCount + pgCount)` |
| **Histogram merge** | durationP50, durationP95 | Merge bucket counts from both sources, recompute percentiles from combined histogram |
| **Approximate** | totalUniques, totalSessions | Redis portion uses cross-day HLL union (exact). PG portion sums per-day PFCOUNT snapshots. Accept ~3% boundary overcount |
| **Derived** | bounceRate, funnel rates | Recompute from merged components (never merge two rates) |
| **Concatenated** | timeSeries | `[...pgEntries, ...redisEntries]` sorted by date |
| **Redis-only** | activeToday | Always live from Redis (today is always in the Redis window) |
| **External** | newMembersInRange | Set by controller from `prisma.user.count()` after getStats() |
| **SQL-based** | retention | Always compute from analytics_events table via SQL CTE |

### Auth Session Enrichment

**Three call sites for `createSession(userId)`** must be updated:

| Method | Current Params | Has `@Req()`? | Change |
|--------|---------------|---------------|--------|
| `login()` | `@Body(), @Res()` | **No** | Add `@Req() req` |
| `register()` | `@Body(), @Res()` | **No** | Add `@Req() req` |
| `changePassword()` | `@Req(), @Body(), @Res()` | **Yes** | No signature change |

**New `createSession` signature:**

```typescript
interface SessionMetadata {
  ip: string;
  userAgent: string;
  country?: string;
  timezone?: string;
  trigger: 'login' | 'register' | 'password_change';
}

async createSession(userId: string, meta?: SessionMetadata): Promise<string>
```

**`createUser` also extended** to accept `registrationIp?` and
`registrationCountry?` for the User model fields.

**Timezone source:** `geoip.lookup(ip).timezone` (geoip-lite returns IANA
timezone). Client-supplied timezone from the login/register body is
accepted as a fallback if geoip returns null.

---

## Admin Integration

### getUserDetail() — Real Data

All fields derived from the enriched Session model.

| Field | Before | After |
|-------|--------|-------|
| `lastLoginIp` | absent | `mostRecentSession.ip` |
| `registrationIp` | absent | `user.registrationIp ?? earliestSession.ip` |
| `device` | `"Unknown"` (in activitySeries) | `mostRecentSession.device` |
| `browser` | absent | `mostRecentSession.browser` |
| `os` | absent | `mostRecentSession.os` |
| `country` | `"Unknown"` (in activitySeries) | `mostRecentSession.country` |
| `timezone` | absent | `mostRecentSession.timezone` |
| `loginCount` | absent | `sessions.length` |

Session query expands from `select: { createdAt: true }` to include all
enrichment fields. Activity series expands from 7 to 30 days.

### New Admin Endpoints (Backend)

| Endpoint | Purpose | Data Source |
|----------|---------|------------|
| `GET /api/admin/users/:id/sessions?page=&limit=` | Paginated session history with device/geo | Session table |
| `GET /api/admin/users/:id/sessions/export?format=csv\|json` | Downloadable session data file | Session table |
| `GET /api/admin/users/:id/activity?page=&limit=` | Unified activity timeline | Fan-out: Review, Comment, Complaint, HelpfulVote, Follow |
| `POST /api/admin/analytics/rollup` | Manual rollup trigger / backfill | Redis → DailySummary |

**Sessions endpoint response:**

```typescript
{
  sessions: Array<{
    id: string;
    ip: string | null;
    ipHash: string | null;
    userAgent: string | null;
    device: string | null;
    browser: string | null;
    os: string | null;
    country: string | null;
    timezone: string | null;
    trigger: string | null;   // login | register | password_change
    createdAt: string;
    expiresAt: string;
  }>;
  pagination: { page, limit, total, totalPages };
}
```

**Export endpoint:**
- Server-side CSV generation via `StreamableFile` (not streaming — <1000
  rows fits in memory). UTF-8 BOM prefix for Excel compatibility.
- `Content-Disposition: attachment; filename="sessions-{username}-{date}.csv"`
- Requires `Content-Disposition` added to CORS `exposedHeaders` in `main.ts`
- CSV columns: IP Hash, User Agent, Device, Browser, OS, Country, Timezone,
  Trigger, Created At, Expires At (no raw IP in export — hash only)
- JSON format: same data structure as paginated endpoint, all records

**Activity endpoint:**
- Fan-out query across 5 tables (Review, Comment, Complaint, HelpfulVote,
  Follow) with parallel `findMany()` calls
- Unified response with `type` discriminator and human-readable `summary`
- In-memory sort by `createdAt` desc, then paginate
- Each sub-query capped at `page * limit` rows

**Rollup endpoint:**
- `POST /api/admin/analytics/rollup` in AdminController (AdminGuard)
- Body: `{ date?, from?, to? }` — single day, range, or yesterday (default)
- Rate-limited: 3/60s short, 10/3600s long
- Range cap: 365 days max
- Response: `{ ok, rolledUp: string[], skipped: string[], errors: [{date, error}], durationMs }`
- Processes in chunks of 10 concurrent days via `Promise.allSettled`

### Rollup Health Monitoring

- Redis key `analytics:rollup:last_success` stores the last successfully
  rolled-up date (no TTL — persists indefinitely)
- `GET /api/analytics/health` extended with rollup status:
  ```json
  { "rollup": { "lastSuccessDate": "2026-03-23", "stale": false } }
  ```
- Staleness threshold: 48 hours (fires before data loss from 32-day TTL)

### New Admin Pages (cryptoi-admin)

| Page | Purpose |
|------|---------|
| `app/dashboard/users/[id]/sessions/page.tsx` | Per-user session history table with pagination |
| `app/dashboard/users/[id]/sessions/ExportSessionsButtons.tsx` | `"use client"` component for CSV/JSON download buttons |

**Link from user detail page:** "View all sessions →" link in the
technical details section, below the existing fields.

**Session history table columns:** IP, Device, Browser, OS, Country,
Timezone, Trigger, Login Date, Expires.

**Export buttons:** Open `window.open(url)` to the BFF export proxy route,
which forwards to the backend export endpoint. Browser handles the file
download natively.

### Where Admin Reads From

| Data | Source |
|------|--------|
| Site-wide stats (last 28 days) | **Redis** |
| Site-wide stats (older than 28 days) | **PostgreSQL** `analytics_daily_summaries` |
| Real-time active visitors | **Redis** sorted set |
| Latest members list | **PostgreSQL** `User` table |
| Per-user profile, device/country/IP | **PostgreSQL** `Session` + `User` tables |
| Per-user session history + export | **PostgreSQL** `Session` table |
| Per-user activity timeline | **PostgreSQL** content tables (Review, Comment, etc.) |

---

## Frontend Changes

| Change | File | Detail |
|--------|------|--------|
| Remove `sendBeacon`, add `credentials: "include"` | `AnalyticsTracker.tsx` | Remove `preferBeacon` param and sendBeacon branch from `sendTrack()`. Add `credentials: "include"` to fetch. `keepalive: true` already handles page unload. No backend CORS/CSRF changes needed (CORS already has `credentials: true`; CSRF handles both logged-in and logged-out states correctly) |
| Track `like` on upvote | `ReviewCard.tsx` | `trackAnalyticsEvent("like")` in `useVote` `onSuccess` when `voteType === "UP"`. Type defined in `FunnelEvent`, zero call sites today |
| Track `signup_started` in sidebar | `SidebarAuthCard.tsx` | Currently only tracked from desktop header (`Header.tsx` inside `hidden lg:flex`) |
| Version consent cookie | `CookieConsent.tsx` | Rename `COOKIE_NAME` from `analytics_consent` to `analytics_consent_v2`. Forces re-consent for expanded scope. `getAnalyticsConsent()` auto-adapts (reads `COOKIE_NAME`) |
| Expand consent banner text | `messages/en.json` | Disclose full scope: IP, location, device/browser info, timezone, session duration, referral source, UTM campaign parameters, funnel events, account linking |
| Update privacy page | `privacy/page.tsx` + `en.json` | Add 6 undisclosed items: timezone, sessionId/localStorage, referrer, UTM params, funnel events, raw UA string. Add new section: server-side activity logging (separate from analytics consent, legitimate interest basis). Update cookies section to mention `analytics_consent_v2` and auth cookie forwarding |

### What Does NOT Change

- `sessionId` handling — stays as-is (random UUID in localStorage, anonymous)
- Session ID does not reset on login/logout — backend links via auth cookies
- No `userId` sent in the track payload — backend reads it from the cookie
- `DeferredExtras.tsx` — tracker and consent already correctly deferred with `ssr: false`

---

## Redis Scaling Fixes

These must be done **before or alongside** the PostgreSQL expansion.

### Fix 1: Pipeline All Redis Commands in track()

**Problem:** Each helper fires 2 sequential commands (data + EXPIRE). True
per-event count is ~34-38 commands across ~17 concurrent but individual
round-trips.

**Fix:** Single `redis.pipeline()` per event branch. All commands queued
locally, sent in one TCP write, responses in one TCP read.

**Cohort SET NX dependency:** The current code does `SET NX` for
`first_visit`, then conditionally `SADD cohort` if the SET succeeded. In a
pipeline, use unconditional `SADD` — it is idempotent (adding an existing
set member is a no-op). Zero data impact, eliminates the `.then()` chain.

**Bounce detection:** Keep the two-step pattern (`HGET session_pages` then
conditional `INCR bounces`). Bounces are NOT idempotent — unconditional
INCR would overcount. The HGET is a single command with no batching benefit.

**Test mock extension:** The Redis mock's `pipeline()` needs chainable
methods (each returning `this`) and a `commands` array for assertions.

### Fix 2: Pre-Compute Retention in Background

**Problem:** `getStats()` calls `SMEMBERS` on cohort sets (500K members at
scale) 30 times sequentially.

**Fix:** Run cohort retention analysis in a background `setInterval` job.
Store result:

```
SET analytics:retention:{day} '{"day1Pct":42,"day7Pct":18,"day30Pct":8}'
```

When `analytics_events` table exists, switch to SQL-based retention (single
CTE query, handles cross-day boundaries natively, more accurate).

### Fix 3: Collapse first_visit Keys

**Problem:** One key per session. 17.5M keys at scale.

**Fix:** Per-day hashes: `HSETNX analytics:first_visit:{day} {sessionId} 1`

### Fix 4: Drop External ipwho.is Fallback

**Problem:** GDPR (undisclosed IP transfer) + latency (100-500ms blocking).

**Fix:** Remove the `fetch('https://ipwho.is/...')` block from
`resolveCountry()`. Use `geoip-lite` only. Accept "unknown" for
unresolvable IPs. Add MaxMind database update mechanism:

- **npm script:** `"geoip:update": "node node_modules/geoip-lite/scripts/updatedb.js"`
- **env var:** `LICENSE_KEY` (MaxMind license key, free registration)
- **Frequency:** Weekly (MaxMind updates GeoLite2 twice per week)
- **When:** Post-deploy or scheduled outside CI

### Fix 5: Bot Detection

**Problem:** Googlebot, Bingbot, GPTBot counted as real page views.

**Fix:** `require('ua-parser-js/bot-detection')` and add
`if (isBot(userAgent)) return;` as an early guard in `track()`, alongside
the existing consent and Redis-ready checks. Two lines of production code.

### Fix 6: ua-parser-js Type Safety

**Problem:** `@types/ua-parser-js@0.7.39` doesn't match v2.0.9. Types
bypassed via `require()` with manual cast.

**Fix:** Remove `@types/ua-parser-js` from devDependencies. Switch to
`import UAParser from 'ua-parser-js'` (v2 ships its own `.d.ts`). Remove
the `as` cast on `parser.getResult()`.

---

## GDPR Compliance

### Retention Tiers

| Tier | Storage | Retention | Contains userId? | Legal Basis |
|------|---------|-----------|-----------------|-------------|
| Hot | Redis counters | 32 days (TTL) | No | Consent (cookie banner) |
| Warm | `analytics_events` (PostgreSQL) | 90 days, then userId SET NULL | Yes (with consent) | Consent + documented LIA |
| Cold | `analytics_daily_summaries` (PostgreSQL) | Indefinitely | No | Anonymous — outside GDPR scope |

### Must-Fix Items

| Item | Phase | Detail |
|------|-------|--------|
| **Consent default** | 0 | Change `if (body.consent === false)` to `if (!body.consent)` |
| **Drop ipwho.is** | 0 | Remove external API fallback. Use geoip-lite only |
| **Bot filtering** | 0 | Add `isBot()` check to `track()` to exclude crawler traffic |
| **IP storage** | 1 | Store `ipHash` (SHA-256) in analytics_events, never raw IP. Session stores raw IP for admin visibility (disclosed in privacy policy) |
| **User deletion** | 2 | Add deletion handler: SET userId = NULL in analytics_events for deleted users |
| **Server-side logging disclosure** | 4 | Separate section in privacy page — legitimate interest, not analytics consent |
| **Consent versioning** | 4 | Version cookie to `analytics_consent_v2` to re-prompt for expanded tracking |

### What NOT to Implement

- **Canvas/WebGL fingerprinting** — legally contested under ePrivacy
- **Raw IP in analytics_events** — hash only; country code is sufficient
- **Unlimited retention of identified events** — 90-day cap, then anonymize
- **Bundled consent** — analytics and marketing must be separate toggles

---

## Implementation Phases

### Phase 0 — Consent Fix + ipwho.is Removal + Bot Detection

**Scope:** Backend-only GDPR/data-quality fixes. Coordinate consent change
with frontend.

**Files:**
- `src/analytics/analytics.service.ts` — consent: `=== false` → `!body.consent`; resolveCountry: remove ipwho.is fetch; track: add `isBot()` guard; import: `require('ua-parser-js/bot-detection')`
- `src/analytics/analytics.service.ts` — import: change `require('ua-parser-js')` to `import UAParser from 'ua-parser-js'`; remove `as` cast on `getResult()`
- `package.json` — remove `@types/ua-parser-js` from devDependencies; add `"geoip:update"` script
- `.env.example` — add `LICENSE_KEY` documentation
- `src/analytics/analytics.service.spec.ts` — update consent tests; add bot UA test cases; update resolveCountry tests
- `test/e2e/analytics.e2e-spec.ts` — update consent e2e cases
- `specs/testing-strategy.md` — remove ipwho.is from risk table

**Breaking change:** Frontend must ship `consent: true` in all payloads
before this deploys, or tracking stops for all clients.

### Phase 1 — Schema Migration

**Scope:** Extend Session + User models, add AnalyticsEvent and
DailySummary tables, update test infra.

**Files:**
- `prisma/schema.prisma` — Session extension (9 new fields incl. trigger), User extension (registrationIp, registrationCountry), AnalyticsEvent model, AnalyticsDailySummary model
- `prisma/migrations/` — generated by `prisma migrate dev`
- `test/helpers/prisma.mock.ts` — add `analyticsEvent`, `analyticsDailySummary` model mocks
- `test/helpers/redis.mock.ts` — extend pipeline mock with chainable methods
- `src/main.ts` — add `X-Analytics-Key` and `Content-Disposition` to CORS `allowedHeaders`/`exposedHeaders`

### Phase 2 — Buffer Service + Server-Side Events + Pipeline

**Scope:** New services, Redis pipeline conversion, session enrichment,
server-side event tracking.

**Files:**
- `src/analytics/analytics-buffer.service.ts` — NEW
- `src/analytics/analytics-buffer.service.spec.ts` — NEW
- `src/analytics/analytics-context.ts` — NEW (AnalyticsContext interface)
- `src/analytics/analytics.interceptor.ts` — NEW (request context extraction)
- `src/analytics/analytics-rollup.service.ts` — NEW (~215 lines)
- `src/analytics/analytics-rollup.service.spec.ts` — NEW
- `src/analytics/ip-utils.ts` — NEW (extract + dedup from controller + service)
- `src/common/ua.ts` — NEW (extract getDeviceAndBrowser)
- `src/analytics/analytics.service.ts` — inject BufferService; convert track() to redis.pipeline(); import from ip-utils.ts; hybrid getStats() with DailySummary merge
- `src/analytics/analytics.controller.ts` — import from ip-utils.ts (remove inline functions); use interceptor
- `src/analytics/analytics.module.ts` — register BufferService, RollupService, Interceptor
- `src/auth/auth.service.ts` — `createSession()` accepts SessionMetadata; `createUser()` accepts registrationIp/Country; add `parseUserAgent()` private method
- `src/auth/auth.controller.ts` — add `@Req()` to login()/register(); pass metadata to createSession(); pass registrationIp/Country to createUser()
- `src/reviews/reviews.service.ts` — add analyticsCtx param to create/vote/helpful
- `src/comments/comments.service.ts` — add analyticsCtx param to create/vote
- `src/complaints/complaints.service.ts` — refactor vote() to capture result; add analyticsCtx
- `src/users/users.service.ts` — add analyticsCtx to follow/unfollow
- `src/search/search.service.ts` — add analyticsCtx; SearchController add `@Req()`
- `test/integration/analytics-buffer.spec.ts` — NEW
- `test/integration/analytics-rollup.spec.ts` — NEW

### Phase 3 — Admin Integration

**Scope:** Real data in getUserDetail(), new endpoints, new admin pages.

**Backend files:**
- `src/admin/admin.service.ts` — change session query; derive real fields; add getUserSessions/getUserSessionsExport/sessionsToCSV/getUserActivity/rollupAnalytics
- `src/admin/admin.controller.ts` — add sessions/sessions-export/activity/rollup routes
- `src/admin/admin.module.ts` — import AnalyticsModule
- `src/admin/dto/sessions-query.dto.ts` — NEW
- `src/admin/dto/sessions-export-query.dto.ts` — NEW
- `src/admin/dto/rollup.dto.ts` — NEW
- `src/admin/admin.service.spec.ts` — update mocks and assertions
- `test/e2e/admin.e2e-spec.ts` — assert real device/country values

**Admin frontend files (cryptoi-admin):**
- `lib/admin-api.ts` — add AdminUserSession interface, fetchUserSessions function
- `app/dashboard/users/[id]/page.tsx` — add "View all sessions →" link
- `app/dashboard/users/[id]/sessions/page.tsx` — NEW (session history table)
- `app/dashboard/users/[id]/sessions/ExportSessionsButtons.tsx` — NEW (client component)
- `app/api/admin/users/[id]/sessions/route.ts` — NEW (BFF proxy)
- `app/api/admin/users/[id]/sessions/export/route.ts` — NEW (BFF proxy)

### Phase 4 — Frontend Changes

**Scope:** Frontend-only, parallel with Phases 2-3.

**Files:**
- `shared/components/analytics/AnalyticsTracker.tsx` — remove sendBeacon, add credentials
- `shared/components/feedback/CookieConsent.tsx` — v2 cookie name
- `features/reviews/components/ReviewCard.tsx` — like event
- `features/account/components/SidebarAuthCard.tsx` — signup_started
- `app/[locale]/privacy/page.tsx` — new disclosure sections (6 analytics items + server-side activity section)
- `messages/en.json` (+ all locales) — expanded consent banner, privacy disclosures

### Phase Dependency Map

```
Phase 0 (consent + ipwho.is + bot filter) ── independent, deploy first
  │
Phase 1 (schema) ──────────────────────────── requires Phase 0 deployed
  │
  ├── Phase 2 (buffer + events + pipeline + rollup) ── requires Phase 1
  │     │
  │     └── Phase 3 (admin) ──────────────────────── requires Phase 2
  │
  └── Phase 4 (frontend) ─────────────────────────── requires Phase 0, parallel with 2-3
```

### No New Dependencies Required

All scheduling uses `setInterval` in `onModuleInit()`. Bot detection uses
the already-installed `ua-parser-js/bot-detection` submodule. No
`@nestjs/schedule` needed.

---

## Appendix: Scaling Analysis

> **Context:** This section is a future reference for when scale demands it.
> The project currently runs as a single NestJS process with no Docker,
> Kubernetes, or cluster configuration. These numbers should not drive
> implementation decisions for current phases.

### Current Scale Memory Budget

At ~300 events/min (~10K sessions/day):

| TTL | Day-Keyed Data | first_visit Keys | ip_country Cache | Total (x1.3 jemalloc) |
|-----|---------------|------------------|------------------|-----------------------|
| 32 days (current) | 40 MB | 48 MB | 20 MB | **~140 MB** |
| 90 days | 113 MB | 135 MB | 20 MB | **~348 MB** |
| 365 days | 460 MB | 548 MB | 20 MB | **~1.3 GB** |

### Bottleneck Priority (What Breaks First)

| # | Bottleneck | Breaks At | Fix |
|---|-----------|----------|-----|
| 1 | `SMEMBERS` on cohort sets in `getStats()` | ~100K DAU | Pre-compute retention / SQL |
| 2 | Redundant EXPIRE doubles Redis command count | Already wasteful | Pipeline all commands |
| 3 | 17.5M `first_visit` keys in Redis keyspace | ~5M users | Collapse into per-day hashes |
| 4 | `resolveCountry()` external HTTP call | Any scale | Drop ipwho.is (Phase 0) |
| 5 | Redis memory (~9-10 GB at 500K DAU) | ~8M users | Separate Redis instance |
| 6 | analytics_events table >500M rows | ~3 months at 10M users | Monthly partitioning (see AUDIT.md) |

### Known ua-parser-js Limitations

| Scenario | Result | Fixable? |
|----------|--------|----------|
| Brave browser | Recorded as "chrome" | No — Brave spoofs Chrome UA |
| iPadOS 13+ default mode | Recorded as desktop/mac_os | No — iPadOS sends macOS UA |
| Smart TV / console / wearable | Mapped to "desktop" | By design (only mobile/tablet distinguished) |
| Bot traffic | Filtered by `isBot()` (Phase 0) | Yes — ua-parser-js/bot-detection |
