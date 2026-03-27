# Cryptoli Backend Audit: 10M+ User Readiness

**Date:** 2026-03-20
**Scope:** Full backend — database, caching, real-time, API, auth, security, horizontal scaling

## Readiness Score: 2.5 / 10

The backend has **solid architectural foundations** — clean module separation, proper auth guards, transaction-safe voting, graceful Redis degradation — but it is currently built for **single-instance, ~10K concurrent user operation**. Reaching 10M users requires addressing fundamental gaps in database indexing, caching, horizontal scaling, and real-time infrastructure.

---

## CRITICAL BLOCKERS (14 issues — must fix before scaling)

These will cause **outages, data loss, or complete system failure** at scale.

### Database & Queries

| # | Issue | Impact | Location |
|---|-------|--------|----------|
| 1 | **17 missing foreign key indexes** | 10-100x slower queries on joins/filters | `prisma/schema.prisma` throughout |
| 2 | **Unbounded `getBySlug()` avg score** — loads ALL reviews into memory | OOM on companies with 100K+ reviews | `companies.service.ts:66-73` |
| 3 | **Unbounded comments include in review detail** | Memory exhaustion, response timeouts | `reviews.service.ts:187-198` |
| 4 | **User cascade delete touches 14+ tables** | 5-30s full DB lock deleting a power user | `schema.prisma` cascade chains |

### Caching & Redis

| # | Issue | Impact | Location |
|---|-------|--------|----------|
| 5 | **Rate limiting fails open when Redis is down** | Zero throttling = DDoS vulnerable | `redis-throttler-storage.ts:52-59` |
| 6 | **Analytics cache stampede** — no lock/latch on cache miss | 10M parallel Redis queries on expiry | `analytics.service.ts:695-698` |
| 7 | **Analytics `track()` does 14+ awaited Redis ops per pageview** | 100M daily calls bottlenecked by serial I/O | `analytics.service.ts:442-626` |

### Socket.IO / Real-Time

| # | Issue | Impact | Location |
|---|-------|--------|----------|
| 8 | **No Redis adapter** — events don't cross instances | Multi-instance deploys silently lose events | `main.ts:154-181` |
| 9 | **Broadcast storms** — `review:created` sent to ALL clients | 1M clients x 3KB = 3GB per review creation | `socket.service.ts:9-12` |
| 10 | **No rate limiting on socket-triggering ops** | Single user can DoS all connected clients | All emit call sites |

### Infrastructure

| # | Issue | Impact | Location |
|---|-------|--------|----------|
| 11 | **No graceful shutdown** — missing SIGTERM/enableShutdownHooks | Dropped requests & connections on every deploy | `main.ts` |
| 12 | **In-process admin caches** — not synced across instances | Stale/inconsistent admin views | `admin.service.ts:20-71` |

### Search & Feed

| # | Issue | Impact | Location |
|---|-------|--------|----------|
| 13 | **ILIKE `%query%` search on unindexed columns** | 5-10s full table scan per search at 10M rows | `search.service.ts:16-80` |
| 14 | **Feed merge is O(n) with unbounded DB re-queries** | Timeouts on deep pagination | `feed.service.ts:119-178` |

---

## HIGH SEVERITY (18 issues — fix within weeks)

| # | Issue | Location |
|---|-------|----------|
| 15 | Missing composite indexes (6+ patterns) | `schema.prisma` |
| 16 | `count()` on every paginated list (no caching) | `reviews.service.ts:103`, `notifications.service.ts:22` |
| 17 | Profile cache invalidation race condition | `users.service.ts:113-145` |
| 18 | Prisma connection pool not configured (default ~2-5) | `prisma.service.ts` |
| 19 | Redis connection — no backoff, no cluster, no pool tuning | `redis.service.ts:17` |
| 20 | IP-country cache unbounded (50M+ keys possible) | `analytics.service.ts:346` |
| 21 | Company lookups not cached (200K queries/sec on feed) | `companies.service.ts:48` |
| 22 | Trending: full table sort on unindexed `helpfulCount` | `trending.service.ts:13-27` |
| 23 | No body size limits configured | `main.ts` |
| 24 | No response compression (gzip) | `main.ts` |
| 25 | No health/readiness endpoint for load balancers | Missing entirely |
| 26 | Unbounded session table growth (no cleanup job) | `auth.service.ts` / `schema.prisma` |
| 27 | No per-user session limit | `auth.service.ts:218-232` |
| 28 | Timing attack on admin/analytics API key comparison | `admin.guard.ts:26`, `analytics.guard.ts` |
| 29 | `X-Analytics-Key` missing from CORS allowedHeaders | `main.ts:108` |
| 30 | Stale push subscriptions never cleaned (3M+ dead rows) | `push.service.ts:61-83` |
| 31 | HTTP polling enabled on Socket.IO (scales poorly) | `main.ts:164` |
| 32 | Stack traces logged to console in production | `errors.ts:65,73` |

---

## MEDIUM SEVERITY (15 issues — fix within months)

| # | Issue | Location |
|---|-------|----------|
| 33 | Vote transaction holds locks during COUNT queries | `reviews.service.ts:222-280` |
| 34 | Profile cache invalidation incomplete (missing mutations) | `users.service.ts` |
| 35 | Admin cache never invalidated on writes | `admin.service.ts` |
| 36 | Analytics in-memory cache unbounded Map growth | `analytics.service.ts:121` |
| 37 | No cache hit/miss metrics anywhere | All caching code |
| 38 | Feed missing category index | `schema.prisma` (Company model) |
| 39 | No search result pagination | `search.service.ts` |
| 40 | Comments listed without pagination | `comments.service.ts` |
| 41 | Username check endpoints not rate limited | `auth.controller.ts:62-97` |
| 42 | No audit logging for admin actions | `admin.controller.ts` |
| 43 | No observability (OpenTelemetry, structured logging) | Entire codebase |
| 44 | No query timeouts on Prisma operations | All services |
| 45 | VAPID keys not validated on startup | `push.service.ts:7-23` |
| 46 | Comment threading unbounded reply loading | `comments.service.ts:139-179` |
| 47 | Search input length not validated | `search.service.ts` |

---

## What's Done Well

- **Auth fundamentals** — bcrypt 10 rounds, SHA-256 session token hashing, httpOnly/Secure/SameSite cookies
- **Vote integrity** — `$transaction` with recount from DB (not increment), spec-compliant
- **Redis graceful degradation** — app doesn't crash when Redis is down
- **Socket.IO null safety** — all emits check `if (!io) return`
- **Input validation** — Zod schemas + ValidationPipe with `forbidNonWhitelisted`
- **CSRF protection** — origin/referer validation middleware
- **Pagination** — most list endpoints have `take` limits (50 max)
- **Module architecture** — clean separation, global modules properly scoped

---

## Prioritized Action Plan

### Phase 1: Stop the Bleeding (Week 1)

1. Add `@@index` on all 17 missing foreign keys
2. Add `take: limit` to unbounded queries (company avg, review comments)
3. Configure Prisma connection pool (`connection_limit=50`)
4. Add body size limits + gzip compression in `main.ts`
5. Implement `app.enableShutdownHooks()` + SIGTERM handler
6. Add `/health` endpoint
7. Fix CORS `allowedHeaders` to include `X-Analytics-Key`

### Phase 2: Scale Foundations (Weeks 2-3)

8. Add Redis adapter for Socket.IO (`@socket.io/redis-adapter`)
9. Move admin caches from in-process Maps to Redis
10. Implement rate limit fallback (in-memory) when Redis is down
11. Add composite indexes for trending, feed, search patterns
12. Cache company objects + trending results in Redis
13. Use `crypto.timingSafeEqual()` for API key comparison
14. Add session cleanup cron + per-user session limits
15. Use Redis pipelining in `analytics.track()`

### Phase 3: Scale for Real (Weeks 4-6)

16. Replace ILIKE search with PostgreSQL GIN full-text indexes (or Elasticsearch)
17. Refactor feed merge to database UNION or cursor-based pagination
18. Pre-compute trending via scheduled job (materialized view or hourly cache)
19. Implement broadcast throttling (batch socket emits, room-scoped events)
20. Denormalize `company.averageRating` updated via transaction
21. Add OpenTelemetry tracing + Prometheus metrics
22. Paginate comments/replies in API responses

### Phase 4: Production Hardening (Month 2+)

23. Read replicas for analytics/search/trending queries
24. Redis Sentinel/Cluster for HA
25. Implement per-event socket rate limiting
26. Encrypt push notification credentials at rest
27. Add admin audit logging
28. Performance test with 100+ concurrent instances

---

## Database Partitioning Strategy (analytics_events)

> **When:** After `analytics_events` exceeds ~50M rows (~4 months at current
> volume, ~1 month at 10M users). Not needed at launch.

### Why Partition

The `analytics_events` table is append-only with time-range queries
(`WHERE created_at BETWEEN ...`). At 200M rows/month (10M user scale),
unpartitioned queries become unacceptably slow. Monthly range partitioning
on `created_at` enables PostgreSQL to scan only the relevant month's
partition, reducing I/O by 10-100x.

### Prisma Limitation

Prisma 6.x has **zero native partitioning support**. There is no
`@@partition`, no `PARTITION BY` syntax in the schema language. All
partitioning must be done via raw SQL migrations.

### Implementation Steps

1. **Create a blank migration:**
   ```bash
   npx prisma migrate dev --create-only --name partition_analytics_events
   ```

2. **Write raw SQL** in the generated `.sql` file:
   ```sql
   -- Rename existing table
   ALTER TABLE "analytics_events" RENAME TO "analytics_events_old";

   -- Create partitioned parent table (identical schema)
   CREATE TABLE "analytics_events" (
     "id" TEXT NOT NULL,
     "event_type" TEXT NOT NULL,
     "session_id" VARCHAR(128),
     "user_id" TEXT,
     "ip_hash" CHAR(64),
     "country" CHAR(2),
     "device" VARCHAR(16),
     "browser" VARCHAR(64),
     "os" VARCHAR(64),
     "timezone" VARCHAR(64),
     "path" VARCHAR(512),
     "referrer" VARCHAR(128),
     "utm_source" VARCHAR(80),
     "utm_medium" VARCHAR(80),
     "utm_campaign" VARCHAR(80),
     "duration_seconds" INTEGER,
     "properties" JSONB DEFAULT '{}',
     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id", "created_at")
   ) PARTITION BY RANGE ("created_at");

   -- Create initial monthly partitions
   CREATE TABLE analytics_events_2026_03 PARTITION OF "analytics_events"
     FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
   CREATE TABLE analytics_events_2026_04 PARTITION OF "analytics_events"
     FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
   -- ... create partitions for the next 3 months

   -- Migrate existing data
   INSERT INTO "analytics_events" SELECT * FROM "analytics_events_old";
   DROP TABLE "analytics_events_old";

   -- Recreate indexes on parent (automatically applies to all partitions)
   CREATE INDEX "analytics_events_user_id_idx" ON "analytics_events" ("user_id");
   CREATE INDEX "analytics_events_event_type_created_at_idx"
     ON "analytics_events" ("event_type", "created_at");
   CREATE INDEX "analytics_events_created_at_idx"
     ON "analytics_events" ("created_at");
   ```

3. **Apply:** `npx prisma migrate dev`

### Critical: Partition Key in Primary Key

PostgreSQL requires the partition key (`created_at`) to be part of the
primary key. This means the PK changes from `(id)` to `(id, created_at)`.
Prisma's schema would need `@@id([id, createdAt])`. Since `AnalyticsEvent`
has no foreign keys referencing it (by design), this change does not cascade.

### Critical: New Partitions Must Be Pre-Created

**If a monthly partition does not exist when an INSERT targets that date
range, PostgreSQL rejects the insert with an error.** Data is silently
lost. Options for ongoing partition management:

| Approach | Complexity | Reliability |
|----------|-----------|-------------|
| **`pg_partman` extension** | Low (install once) | High — auto-creates partitions ahead of time |
| **Scheduled SQL job** (via `pg_cron` or external cron) | Medium | Medium — depends on cron reliability |
| **Manual migration per month** | Low code, high ops | Low — human error risk |

**Recommendation:** Use `pg_partman` if your PostgreSQL provider supports
extensions. Otherwise, a monthly cron job that runs:
```sql
SELECT partman.create_parent('public.analytics_events', 'created_at', 'native', 'monthly');
```

### BRIN Index Optimization

At >100M rows, replace the B-tree index on `created_at` with a BRIN
(Block Range Index):
```sql
DROP INDEX "analytics_events_created_at_idx";
CREATE INDEX "analytics_events_created_at_brin" ON "analytics_events"
  USING BRIN ("created_at") WITH (pages_per_range = 128);
```
BRIN indexes are ~128 bytes vs ~2 GB for a B-tree at 100M rows. They work
well on append-only tables where `created_at` values are naturally ordered.

### Prisma Compatibility

Prisma reads and writes transparently through the parent table name
(`analytics_events`). It is unaware of partitions. All queries, including
`createMany()` from the BufferService, work without code changes. The
partitioning is purely a PostgreSQL-level optimization invisible to the ORM.

---

## Bottom Line

The codebase is **well-organized and thoughtfully designed for a single-instance MVP**. The core business logic (voting, auth, notifications) is sound. But the path to 10M users requires:

- **Database**: ~25 missing indexes, unbounded queries, cascade redesign
- **Caching**: Strategy exists but is incomplete — cache stampede, missing invalidation, no company/trending/feed caching
- **Real-time**: Single-instance only — needs Redis adapter, broadcast optimization, rate limiting
- **Infrastructure**: No graceful shutdown, no health checks, no observability, in-process state breaks multi-instance

**Phases 1-2 (3 weeks of focused work) would bring readiness to ~6/10** — capable of handling 500K-1M users. **Phases 3-4 would reach 7-8/10** for the 10M target. The remaining gap would be filled by infrastructure (load balancers, read replicas, CDN, monitoring) rather than code changes.
