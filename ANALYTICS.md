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
- [Future: Historical Analytics](#future-historical-analytics)
- [Appendix: Scaling Analysis](#appendix-scaling-analysis)

---

## Current State

### What Exists

| Layer | Role | Details |
|-------|------|---------|
| **Frontend** (`cryptoli-frontend`) | Event producer | `AnalyticsTracker.tsx` sends `page_view`, `page_leave`, `signup_started`, `signup_completed` via `POST /api/analytics/track`. Defines but never emits `purchase` or `like`. Uses `sendBeacon` for page_leave, `fetch+keepalive` for others. No `credentials: "include"` — auth cookies are NOT sent. Cookie consent gate (`analytics_consent` cookie). Session ID in localStorage. |
| **Backend** (`cryptoli`) | Redis-only storage | `AnalyticsService.track()` writes ~34-38 Redis commands per event (15 data + 15 EXPIRE + extras for cohort/realtime). Uses `Promise.all` with individual awaits, not `redis.pipeline()`. 32-day TTL. Fire-and-forget. No PostgreSQL analytics tables. `resolveCountry()` falls back to external `ipwho.is` API on geoip-lite miss. |
| **Admin** (`cryptoi-admin`) | Read-only dashboards | `/dashboard/analytics` reads site-wide stats via `GET /api/analytics/stats` (max 90-day range). Polls `/api/analytics/realtime` every 30s. `/dashboard/users/[id]` shows per-user detail — admin page is **ready** to render device/browser/OS/country/timezone/IP fields but backend returns no data for them. |

### What's Missing

| Gap | Impact |
|-----|--------|
| Data expires after 32 days | No historical analysis beyond Redis TTL window |
| No user-linked events | Can't answer "what did user X do?" |
| No server-side action tracking | Reviews, votes, follows, comments invisible to analytics |
| No raw event log | Can't drill down, replay, or run ad-hoc queries |
| Backend returns no device/country/IP/browser/OS/timezone for users | `activitySeries` hardcodes `device: "Unknown"`, `country: "Unknown"`; IP/browser/OS/timezone are absent entirely. Admin page shows "—" fallback |
| Session model has no context fields | Only stores id, userId, token, expiresAt, createdAt |
| `resolveCountry()` calls external `ipwho.is` | Undisclosed third-party data transfer; 100-500ms blocking on cache miss |
| Consent check treats undefined as consent | `if (body.consent === false)` lets undefined through — GDPR requires opt-in |

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

Backend (cryptoli)
  - Stores everything in Redis (zero PG analytics tables)
  - Zero server-side activity tracking (no other module imports AnalyticsModule)
  - AnalyticsService injects only RedisService (no PrismaService)
  - AnalyticsController injects PrismaService for User.count() in stats endpoint
  - normalizeIp and isPrivateOrLocalIp are duplicated between controller and service
  - AuthController.login()/register() lack @Req() — no access to request metadata
```

---

## Design Goals

1. Track everything about users **externally** (IP, device, browser, OS, timezone,
   country, referrer) — per session, per action.
2. Track everything about users **internally** (all activity: reviews, votes,
   follows, comments, logins, searches, profile updates).
3. Keep Redis as the fast/hot layer for real-time site-wide analytics (unchanged).
4. Add PostgreSQL persistence for durable storage, per-user drill-down, and
   ad-hoc queries.
5. Feed the admin's per-user detail page with real data instead of "—".
6. Comply with GDPR (hash IPs, 90-day identified retention, consent-based).

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
│    ├── extract IP, UA, country from headers                                 │
│    ├── [NEW] extract userId from auth cookie (when authenticated)           │
│    │                                                                        │
│    └──► AnalyticsService.track(ip, ua, body, countryHint, serverCtx?)       │
│           │                                                                 │
│           ├──► Redis pipeline (unchanged semantics, now pipelined)          │
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
│    ip, ipHash, userAgent, device, browser, os, country, timezone            │
│                                                                             │
│  AnalyticsService.getStats() ── REDIS READER (unchanged):                   │
│    reads from Redis keys (up to 32-day window)                              │
└─────────────────────────────────────────────────────────────────────────────┘
                          │                        │
              ┌───────────▼──────────┐    ┌───────▼────────────────┐
              │       REDIS          │    │    POSTGRESQL           │
              │                      │    │                         │
              │  analytics:* keys    │    │  Session (extended)     │
              │  32-day TTL          │    │    + ip, ipHash         │
              │  Real-time counters  │    │    + userAgent, device  │
              │  HLL uniques         │    │    + browser, os        │
              │  Sorted set active   │    │    + country, timezone  │
              │                      │    │                         │
              │  (unchanged purpose, │    │  [NEW] AnalyticsEvent   │
              │   pipelining added)  │    │    raw event log        │
              │                      │    │                         │
              └──────────────────────┘    │  User (extended)        │
                                          │    + registrationIp     │
              ┌───────────────────────┐   │    + registrationCountry│
              │       ADMIN           │   │                         │
              │                       │   └─────────────────────────┘
              │  /dashboard/analytics │
              │    reads stats+real-  │
              │    time (30-day max)  │
              │                       │
              │  /dashboard/users/[id]│
              │    REAL device/country│
              │    session history    │
              │    activity timeline  │
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
AnalyticsController.track()
  │  getClientIp(req)        → IP from headers (CF, nginx, Forwarded, etc.)
  │  getCountryHint(req)     → country code from CDN headers
  │  req.user?.userId        → from auth cookie (if authenticated)
  │
  ▼
AnalyticsService.track(ip, ua, body, countryHint, serverCtx?)
  │  if (!body.consent) return;    ← consent gate (explicit opt-in)
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
  │      ... (EXPIRE only on key creation, not every call)
  │      pipeline.exec()
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
  │  authorId from req.user
  │  analyticsCtx extracted by AnalyticsInterceptor from req
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

### Read Path: Site-Wide Stats

```
GET /api/analytics/stats?from=2026-02-21&to=2026-03-23
  │
  ▼
AnalyticsService.getStats(from, to)
  │
  └── Redis: 22-key-per-day read loop (existing, unchanged)
      └──► return AnalyticsStats (up to 32-day window)
```

> **Future:** When historical analytics is implemented (see [Future: Historical
> Analytics](#future-historical-analytics)), getStats() becomes a hybrid reader
> that merges Redis (recent) with PostgreSQL (older) data.

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
        lastLoginIp   = mostRecentSession.ip
        registrationIp = user.registrationIp ?? earliestSession.ip
        device         = mostRecentSession.device
        browser        = mostRecentSession.browser
        os             = mostRecentSession.os
        country        = mostRecentSession.country
        timezone       = mostRecentSession.timezone
        loginCount     = sessions.length
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

  // NEW — request context captured at login/register
  ip        String?  @db.VarChar(45)   // max IPv6 length
  ipHash    String?  @db.Char(64)      // SHA-256 hex
  userAgent String?  @db.VarChar(512)
  device    String?  @db.VarChar(16)   // desktop | mobile | tablet
  browser   String?  @db.VarChar(64)
  os        String?  @db.VarChar(64)
  country   String?  @db.Char(2)       // ISO 3166-1 alpha-2
  timezone  String?  @db.VarChar(64)   // IANA tz string

  @@index([userId])
  @@index([createdAt])
}
```

### User Model (Extended)

Add after `subscription` field, before `createdAt`. Only fields that cannot
be reliably derived from sessions — if sessions are pruned or expired, the
earliest session data is lost.

```prisma
  registrationIp      String?   @map("registration_ip")      @db.VarChar(45)
  registrationCountry String?   @map("registration_country") @db.Char(2)
```

> **Dropped from original proposal:** `lastLoginAt`, `lastLoginIp`, `loginCount`
> are always derivable from the enriched Session table (`mostRecentSession.ip`,
> `sessions.length`, etc.). Adding them creates a dual source of truth requiring
> sync on every login. The admin's `getUserDetail()` already queries all sessions
> and derives `lastLoginAt` from the most recent one.

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
  @@index([createdAt])  // replace with BRIN in raw SQL when volume warrants

  @@map("analytics_events")
}
```

**Partitioning strategy:** Start as a standard heap table. Add monthly
`PARTITION BY RANGE (created_at)` via a dedicated raw SQL migration when
the table exceeds 50M rows. Prisma reads/writes transparently through the
parent table.

**Index decisions:** Start with 2 indexes only (userId, eventType+createdAt).
Drop sessionId B-tree (not queried on this table). Add indexes later based
on actual query patterns. Reduces write amplification by ~60%.

### Storage Estimates

At ~300 events/min (current):

| Table | Rows/month | Size/year |
|-------|-----------|-----------|
| analytics_events | ~13M | ~70 GB |

---

## Service Architecture

### New Service

| Service | File | Responsibility | Scheduling |
|---------|------|---------------|------------|
| `AnalyticsBufferService` | `src/analytics/analytics-buffer.service.ts` | In-memory event buffer, batch flush to PG | `setInterval` (2s) |

### Shared Utilities

Extract shared IP and UA utilities when Phase 2 creates the second call site
(AuthController needs `getClientIp`/`getCountryHint`; AuthService needs
`getDeviceAndBrowser`). Do not extract prematurely.

**Immediate dedup needed:** `normalizeIp` and `isPrivateOrLocalIp` are
currently duplicated between `analytics.controller.ts` (lines 25, 42) and
`analytics.service.ts` (lines 291, 312). Consolidate during Phase 2.

| Utility | File | Extracted From | When |
|---------|------|---------------|------|
| `getClientIp`, `getCountryHint`, `normalizeIp`, `isPrivateOrLocalIp` | `src/common/ip.ts` | `analytics.controller.ts` + `analytics.service.ts` | Phase 2 (when AuthController needs them) |
| `getDeviceAndBrowser` | `src/common/ua.ts` | `analytics.service.ts` | Phase 2 (when AuthService needs it) |

### AnalyticsBufferService

```typescript
@Injectable()
export class AnalyticsBufferService implements OnModuleInit, OnModuleDestroy {
  private buffer: BufferedEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  // Constants
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
- `splice(0, length)` before `await` prevents race conditions with concurrent pushes
- On PG failure: logs error, does not re-queue (analytics loss acceptable)
- On graceful shutdown: `onModuleDestroy` drains buffer before PrismaService disconnects

### Request Context Propagation

Use a NestJS interceptor to automatically extract request context, avoiding
boilerplate in every controller and preventing silent tracking gaps when new
endpoints are added.

```typescript
// src/analytics/analytics.interceptor.ts
@Injectable()
export class AnalyticsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest();
    req.analyticsCtx = {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? '',
      country: getCountryHint(req),
      userId: req.user?.userId,
    };
    return next.handle();
  }
}
```

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
parameter. Controllers that need server-side tracking simply read
`req.analyticsCtx` — no manual extraction per endpoint.

> **Why interceptor over per-controller extraction:** The original proposal
> required manually calling `getClientIp(req)` in 7+ controllers. This risks
> silently forgetting context when new endpoints are added. An interceptor
> ensures consistent extraction. If fine-grained control is needed per route,
> apply the interceptor selectively via `@UseInterceptors()`.

> **Why not socket-event tapping:** The existing SocketService emits 7 event
> types (`review:created`, `review:vote:updated`, etc.) after DB writes.
> Intercepting these was considered but rejected because socket events lack
> request context (IP, UA, country). Per-service injection allows capturing
> the full request context alongside the action.

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

> **Merged:** `review_helpful` is tracked as `vote_cast` with
> `properties.action = "helpful_toggle"` — both operations write to the same
> HelpfulVote model, so a separate event type adds no value.

Events are emitted **after** DB writes and **after** socket emissions,
matching the existing socket emit ordering convention.

### Module Registration Changes

| Module | Change |
|--------|--------|
| `AnalyticsModule` | Add `AnalyticsBufferService` to providers |
| `AuthModule` | Import `AnalyticsModule` (for tracking login/register events). No circular dep — Auth→Analytics is one-directional |
| `ReviewsModule` | Import `AnalyticsModule` |
| `CommentsModule` | Import `AnalyticsModule` |
| `ComplaintsModule` | Import `AnalyticsModule` |
| `UsersModule` | Import `AnalyticsModule` |
| `SearchModule` | Import `AnalyticsModule` |

### Implementation Notes

**AuthController.login() and register() currently lack `@Req()`** — they
take `@Body()` and `@Res()` only. Phase 2 must add `@Req() req` to these
method signatures to access request metadata for session enrichment. This
will require updating existing test mocks.

---

## Admin Integration

### getUserDetail() — Real Data

All fields derived from the enriched Session model. No denormalized columns
on User except `registrationIp` and `registrationCountry` (insurance against
session pruning).

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
| `activitySeries[].device` | `"Unknown"` | `Record<string, number>` per day |
| `activitySeries[].country` | `"Unknown"` | `Record<string, number>` per day |

Session query changes from `select: { createdAt: true }` to include all
enrichment fields. Activity series expands from 7 to 30 days.

### New Admin Endpoints

| Endpoint | Purpose | Data Source |
|----------|---------|------------|
| `GET /api/admin/users/:id/sessions?page=&limit=` | Paginated session history with device/geo | Session table |
| `GET /api/admin/users/:id/activity?page=&limit=` | Unified activity timeline | Fan-out: Review, Comment, Complaint, Post, HelpfulVote |

### Where Admin Reads From

| Data | Source |
|------|--------|
| Site-wide stats (last 30 days) | **Redis** |
| Real-time active visitors | **Redis** sorted set |
| Latest members list | **PostgreSQL** `User` table |
| Per-user profile, activity, device/country/IP | **PostgreSQL** `Session` + `User` tables |
| Per-user session history | **PostgreSQL** `Session` table |
| Per-user activity timeline | **PostgreSQL** content tables (Review, Comment, etc.) |

---

## Frontend Changes

| Change | File | Detail |
|--------|------|--------|
| Add `credentials: "include"` | `AnalyticsTracker.tsx` | Sends auth cookies so backend can link userId server-side |
| Replace `sendBeacon` with `fetch` + `keepalive: true` | `AnalyticsTracker.tsx` | `sendBeacon` currently used for page_leave; can't carry cookies. Replace with `fetch+keepalive` for all events |
| Track `like` on upvote | `ReviewCard.tsx` | `trackAnalyticsEvent("like")` in `useVote` `onSuccess` when `voteType === "UP"`. Type already defined in `FunnelEvent`, zero call sites today |
| Track `signup_started` in sidebar | `SidebarAuthCard.tsx` | Currently only tracked from desktop header (`Header.tsx` inside `hidden lg:flex` div) |
| Version consent cookie | `CookieConsent.tsx` | Rename from `analytics_consent` to `analytics_consent_v2` to re-prompt for expanded tracking |
| Update privacy page | `privacy/page.tsx` + `en.json` | Disclose userId linking, server-side activity logging, funnel tracking |

### What Does NOT Change

- `sessionId` handling — stays as-is (random UUID in localStorage, anonymous)
- Session ID does not reset on login/logout — backend links via auth cookies
- No `userId` sent in the track payload — backend reads it from the cookie
- `DeferredExtras.tsx` — tracker and consent already correctly deferred with `ssr: false`

---

## Redis Scaling Fixes

These must be done **before or alongside** the PostgreSQL expansion. The
current Redis layer has bottlenecks that hit before any PG concern.

### Fix 1: Pipeline All Redis Commands in track()

**Problem:** Each `incr()`/`hincrby()`/`pfadd()` helper fires 2 sequential
commands (data + EXPIRE). True per-event count is ~34-38 commands, not 16.
Uses `Promise.all` with individual awaits — concurrent but not pipelined.

**Fix:** Replace individual awaited commands with a single `redis.pipeline()`:

```typescript
const pipe = this.redis.pipeline();
pipe.incr(`analytics:pageviews:${day}`);
pipe.expire(`analytics:pageviews:${day}`, TTL_SECONDS);
pipe.pfadd(`analytics:hll:uniques:${day}`, sessionId);
// ... all other commands
pipe.exec(); // single round-trip
```

Set EXPIRE only on key creation (check command return values) or accept
the minor redundancy within the pipeline (no extra round-trips).

### Fix 2: Pre-Compute Retention in Background

**Problem:** `getStats()` calls `SMEMBERS` on cohort sets (500K members at
scale) 30 times sequentially. At 500K DAU, this takes 6-10 seconds and
blocks the event loop.

**Fix:** Run cohort retention analysis in a background `setInterval` job
(same pattern as BufferService). Store result:

```
SET analytics:retention:{day} '{"day1Pct":42,"day7Pct":18,"day30Pct":8}'
```

`getStats()` reads the pre-computed JSON instead of computing on the fly.

### Fix 3: Collapse first_visit Keys

**Problem:** `analytics:first_visit:{sessionId}` creates one key per new
session. At 500K sessions/day x 35-day TTL = 17.5M individual keys.
Consumes ~2.6 GB and degrades keyspace operations.

**Fix:** Use per-day hashes instead:

```
HSETNX analytics:first_visit:{day} {sessionId} 1
```

Reduces 17.5M keys to 35 hash keys.

### Fix 4: Drop External ipwho.is Fallback

**Problem:** `resolveCountry()` calls `ipwho.is` on cache miss — 100-500ms
blocking per new IP. Also an undisclosed third-party data transfer (GDPR
concern — user IPs sent to external service without disclosure).

**Fix:** Use `geoip-lite` only (already installed, synchronous). Accept
"unknown" for IPs not in the local MaxMind database. If higher accuracy
is needed, self-host a MaxMind GeoIP2 database.

> **This is a GDPR compliance issue, not just a scaling fix.** Implemented
> in Phase 0 alongside the consent fix.

---

## GDPR Compliance

### Retention Tiers

| Tier | Storage | Retention | Contains userId? | Legal Basis |
|------|---------|-----------|-----------------|-------------|
| Hot | Redis counters | 32 days (TTL) | No | Consent (cookie banner) |
| Warm | `analytics_events` (PostgreSQL) | 90 days, then userId SET NULL | Yes (with consent) | Consent + documented LIA |

### Must-Fix Items

| Item | Phase | Detail |
|------|-------|--------|
| **Consent default** | 0 | Change `if (body.consent === false)` to `if (!body.consent)` — undefined must mean "no consent" |
| **Drop ipwho.is** | 0 | Remove external API fallback. Use geoip-lite only. Eliminates undisclosed third-party data transfer |
| **IP storage** | 1 | Store `ipHash` (SHA-256) in analytics_events, never raw IP. Session stores raw IP for admin visibility (disclosed in privacy policy) |
| **User deletion** | 2 | `userId` in analytics_events has no FK. Add a deletion handler that SETs userId to NULL for deleted users' events |
| **Server-side logging** | 5 | Separate disclosure section in privacy page — covered under legitimate interest, not analytics consent |
| **Consent versioning** | 5 | Version cookie to `analytics_consent_v2` to re-prompt when tracking scope expands |

### What NOT to Implement

- **Canvas/WebGL fingerprinting** — legally contested under ePrivacy, not
  worth the risk
- **Raw IP in analytics_events** — hash only; country code is sufficient
- **Unlimited retention of identified events** — 90-day cap, then anonymize
- **Bundled consent** — analytics and marketing must be separate toggles

---

## Implementation Phases

### Phase 0 — Consent Fix + ipwho.is Removal

**Scope:** Backend-only fixes for GDPR compliance. Coordinate consent change
with frontend.

**Files:**
- `src/analytics/analytics.service.ts` — line 449: `if (body.consent === false)` -> `if (!body.consent)`
- `src/analytics/analytics.service.ts` — `resolveCountry()`: remove `ipwho.is` fetch fallback, use geoip-lite only
- `src/analytics/analytics.service.spec.ts` — update consent + country resolution tests
- `test/e2e/analytics.e2e-spec.ts` — update consent e2e cases

**Breaking change:** Frontend must ship `consent: true` in all payloads
before this deploys, or tracking stops for all clients.

**Rollback:** Revert consent check and resolveCountry changes. No schema change.

### Phase 1 — Schema Migration

**Scope:** Extend Session + User models, add AnalyticsEvent table, update
test infra.

**Files:**
- `prisma/schema.prisma` — Session extension (8 new fields), User extension (registrationIp, registrationCountry), AnalyticsEvent model
- `prisma/migrations/` — generated by `prisma migrate dev`
- `test/helpers/prisma.mock.ts` — add `analyticsEvent` model mock
- `test/helpers/test-db.setup.ts` — add new table name to validation list

**Backward compatibility:** All new fields nullable. No existing behavior changes.

**Rollback:** Drop new table, remove new columns.

### Phase 2 — Buffer Service + Server-Side Events

**Scope:** New services, modify track() and feature services.

**Files:**
- `src/analytics/analytics-buffer.service.ts` — NEW
- `src/analytics/analytics-buffer.service.spec.ts` — NEW
- `src/analytics/analytics-context.ts` — NEW (AnalyticsContext interface)
- `src/analytics/analytics.interceptor.ts` — NEW (request context extraction)
- `src/common/ip.ts` — NEW (extract + dedup getClientIp, getCountryHint, normalizeIp, isPrivateOrLocalIp)
- `src/common/ua.ts` — NEW (extract getDeviceAndBrowser)
- `src/analytics/analytics.service.ts` — inject BufferService, call push() after Redis writes; import from common/ip.ts
- `src/analytics/analytics.controller.ts` — import from common/ip.ts (remove inline functions)
- `src/analytics/analytics.module.ts` — register BufferService
- `src/auth/auth.service.ts` — `createSession()` accepts metadata, populates Session fields
- `src/auth/auth.controller.ts` — add `@Req() req`, pass IP/UA/country/timezone at login/register
- `src/reviews/reviews.service.ts` — add analyticsCtx param, emit events
- `src/comments/comments.service.ts` — same
- `src/complaints/complaints.service.ts` — same
- `src/users/users.service.ts` — same
- `src/search/search.service.ts` — same
- `test/integration/analytics-buffer.spec.ts` — NEW

**Rollback:** Remove BufferService, revert track() and service signatures.
Any rows already in analytics_events are harmless.

### Phase 3 — Admin Integration

**Scope:** Real data in getUserDetail(), new endpoints.

**Files:**
- `src/admin/admin.service.ts` — change session query, derive real fields, add getUserSessions/getUserActivity
- `src/admin/admin.controller.ts` — add sessions/activity routes
- `src/admin/admin.service.spec.ts` — update mocks and assertions
- `test/e2e/admin.e2e-spec.ts` — assert real device/country values

**Can partially parallel with Phase 2** once Phase 1 is deployed.

**Rollback:** Revert getUserDetail() changes. No schema impact.

### Phase 4 — Frontend Changes

**Scope:** Frontend-only, parallel with Phases 2-3.

**Files:**
- `shared/components/analytics/AnalyticsTracker.tsx` — credentials, remove beacon
- `shared/components/feedback/CookieConsent.tsx` — v2 cookie, expanded copy
- `features/reviews/components/ReviewCard.tsx` — like event
- `features/account/components/SidebarAuthCard.tsx` — signup_started
- `app/[locale]/privacy/page.tsx` — new disclosure sections
- `messages/en.json` (+ all locales) — updated privacy copy

### Phase Dependency Map

```
Phase 0 (consent + ipwho.is) ── independent, deploy first
  │
Phase 1 (schema) ──────────────── requires Phase 0 deployed
  │
  ├── Phase 2 (buffer + events) ── requires Phase 1
  │
  ├── Phase 3 (admin) ──────────── requires Phase 1, partially parallel with 2
  │
  └── Phase 4 (frontend) ───────── requires Phase 0, parallel with 2-3
```

### No New Dependencies Required

All scheduling needs (BufferService flush, retention pre-compute) use
`setInterval` in `onModuleInit()` — no `@nestjs/schedule` needed.

---

## Future: Historical Analytics

> **Status:** Deferred. Not required for the stated goals (track everything
> about users externally and internally). Implement only when the 32-day
> Redis window proves insufficient for admin needs.

When this becomes needed, the approach would be:

1. **AnalyticsDailySummary table** — permanent aggregates by date and
   dimension, populated by a nightly job before Redis keys expire.
2. **Hybrid getStats()** — reads recent days from Redis, older days from
   PostgreSQL, merges results.
3. **Extended dashboard range** — admin `parseRangeDays` max: 90 -> 365,
   with "Last 6 months" and "Last year" options.
4. **Scheduling** — either `setInterval`-based hourly check, an admin HTTP
   endpoint triggered by external cron, or `@nestjs/schedule` if approved.

The 2-day buffer (30 vs 32-day TTL) ensures no day is read from both
sources. The existing 1-minute in-process `statsCache` applies to the
merged result.

---

## Appendix: Scaling Analysis

> **Context:** This section is a future reference for when scale demands it.
> The project currently runs as a single NestJS process with no Docker,
> Kubernetes, or cluster configuration. These numbers should not drive
> implementation decisions for current phases.

### Scale Assumptions (10M Registered Users)

- DAU: 1-5% = 100K-500K daily active users
- Events per active user: ~13/day (10 page views + 2 actions + 1 session)
- Peak: ~4,500 events/min = 75 events/sec
- analytics_events growth: ~200M rows/month at peak

### Bottleneck Priority (What Breaks First)

| # | Bottleneck | Breaks At | Fix |
|---|-----------|----------|-----|
| 1 | `SMEMBERS` on cohort sets in `getStats()` | ~100K DAU | Pre-compute retention in background job |
| 2 | Redundant EXPIRE doubles Redis command count | Already wasteful | Pipeline all commands |
| 3 | 17.5M `first_visit` keys in Redis keyspace | ~5M users | Collapse into per-day hashes |
| 4 | `resolveCountry()` external HTTP call | Any scale with cache misses | Drop ipwho.is, use geoip-lite only |
| 5 | Redis memory (~9-10 GB at 500K DAU) | ~8M users on 32 GB instance | Dedicate separate Redis for analytics |
| 6 | PG connection pool (9 default) at 20+ instances | ~20 NestJS instances | PgBouncer or separate analytics pool |
| 7 | analytics_events table >500M rows | ~3 months at 10M users | Monthly partitioning + BRIN index |

### Redis: Memory Budget at 500K DAU

| Component | Memory |
|-----------|--------|
| `first_visit` keys (17.5M) | ~2.6 GB |
| Cohort sets (17.5M members) | ~1.6 GB |
| `session_pages` hashes (16M entries) | ~1.4 GB |
| `ip_country` cache (up to 10M) | ~1.2 GB |
| Path/referrer/utm hashes | ~130 MB |
| HLL, fixed hashes, sorted set | ~50 MB |
| **Total (+ jemalloc 1.3-1.5x)** | **~9-10 GB** |
