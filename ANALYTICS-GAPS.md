# Analytics Gaps & Security Findings

> Identified 2026-03-28 via adversarial verification + consultation across 9 expert agents.
> Scope: commits 7cb34e0..fd8bd12 (analytics platform, CORS fixes, comments revert).

## Status

| # | Fix | Priority | Status |
|---|-----|----------|--------|
| 1 | [IP privacy overhaul](#1-ip-privacy-overhaul) | **Critical** | Open |
| 2 | [Health endpoint information disclosure](#2-health-endpoint-information-disclosure) | **Medium** | Open |
| 3 | [Redis cache key leaks plaintext IP](#3-redis-cache-key-leaks-plaintext-ip) | **Low** | Open (bundle with fix 1) |
| 4 | [Timing-unsafe API key comparison](#4-timing-unsafe-api-key-comparison) | **Low** | Open (Phase 2) |
| 5 | [Error leakage in latest-members](#5-error-leakage-in-latest-members) | **Low** | Open |
| 6 | [Dead export `const dynamic`](#6-dead-export-const-dynamic) | **Trivial** | Open |

---

## 1. IP Privacy Overhaul

**Priority: Critical** | Effort: Medium | Files: `analytics.service.ts`, `auth.service.ts`, `prisma/schema.prisma`

### Problem

`hashIp()` at `src/analytics/analytics.service.ts:426-429` computes `SHA-256(raw_ip)` with
no salt and no subnet truncation. The hash is stored permanently in
`analytics_events.ip_hash`.

**This provides zero meaningful protection.** The entire IPv4 address space (~4.3B addresses)
can be brute-forced in under 1 second on a single consumer GPU (RTX 4090: ~22 GH/s SHA-256).
A precomputed lookup table fits in ~200 GB. No rainbow table optimization is even needed.

EDPB Guidelines 01/2025 on Pseudonymisation explicitly classify unsalted hashed IPs as
personal data under GDPR. The current implementation would not pass a GDPR audit.

### Full IP Lifecycle

| Location | Format | Retention | Access |
|----------|--------|-----------|--------|
| `analytics_events.ip_hash` (PG) | SHA-256 of full IP, unsalted | **Permanent** (GDPR anonymization only nullifies `user_id`, not `ip_hash`) | Written by 6 callers in `track()`. **Read by zero queries.** |
| `Session.ip` (PG) | **Plaintext IP** | Session lifetime (no cleanup cron found) | Admin panel: `lastLoginIp`, `registrationIp` fallback |
| `User.registrationIp` (PG) | **Plaintext IP** | **Permanent** | Admin panel |
| `Session.ipHash` (PG) | SHA-256 of full IP, unsalted | Same as Session row | Admin session export |
| `analytics:ip_country:{ip}` (Redis) | **Plaintext IP in key** | 30-day TTL | See [fix 3](#3-redis-cache-key-leaks-plaintext-ip) |
| In-flight memory | Plaintext, transient | Single `track()` call | Never logged |

**Key observation:** `analytics_events.ip_hash` is written but never read by any query. No
code filters, groups, or joins on this column. It exists purely as an audit dimension that
nobody consumes.

**Second code path:** `AuthService.createSession()` at `src/auth/auth.service.ts:256-257`
has an independent identical `SHA-256(raw_ip)` — same unsalted pattern. Both produce
identical hashes for the same IP.

### Industry Comparison

| Platform | Approach | Salt | Retention |
|----------|----------|------|-----------|
| **Plausible** | `hash(daily_salt + domain + ip + ua)` | Daily rotating, deleted after use | Hash never stored long-term |
| **Fathom** | `SHA-256(site_salt + ip + ua + hostname)` | Per-site, daily rotation | Salt deleted at midnight |
| **Umami** | `hash(HASH_SALT + ip + ua + ...)` | Static env var (criticized) | Hash used for session dedup |
| **Matomo** | Octet truncation (no hashing) | N/A | Truncated IP stored |
| **Google Analytics** | Zero last octet in memory | N/A | Full IP never written to disk |
| **This project** | `SHA-256(raw_ip)` | **None** | **Permanent** |

### Options

| Approach | Privacy | Complexity | Trade-off |
|----------|---------|------------|-----------|
| **A. Daily rotating salt + ephemeral hash** | Gold standard | High — salt rotation cron, schema change | Plausible/Fathom model. Best GDPR posture. |
| **B. Static per-instance salt + /24 truncation** | Acceptable | Medium — new env var `IP_HASH_SALT`, truncate before HMAC | Umami model. Pragmatic middle ground. |
| **C. Truncation only** | Minimal | Low — 5-line change to `hashIp()` | Matomo/GA model. Cheapest, weakest improvement. |
| **D. Stop writing `ipHash` to analytics_events** | Eliminates the problem | Low — remove column from buffer writes | Column is never read. If no consumer needs it, don't store it. |

**Recommendation:** Option B + D combined. Stop writing `ipHash` to `analytics_events`
(since nothing reads it), and upgrade `hashIp()` to `HMAC-SHA256(salt, truncated_ip)` for
the Session table where the hash is actually used by admin endpoints. Add `IP_HASH_SALT` to
`.env.example`. Address `Session.ip` and `User.registrationIp` plaintext storage as a
follow-up (requires admin panel UX decision).

### Spec Reference

`specs/analytics-system.md:98` says "IP hashed (SHA-256), never stored raw" — the code
complies with the spec's letter but not its spirit. The spec should be updated to require
salting and define retention policy for `ip_hash`.

---

## 2. Health Endpoint Information Disclosure

**Priority: Medium** | Effort: 10 min | File: `src/analytics/analytics.controller.ts:73-90`

### Problem

`GET /api/analytics/health` has **no auth guard** while every other analytics endpoint
(except `POST /track`) uses `@UseGuards(AnalyticsGuard)`. The response includes:

| Field | What it leaks |
|-------|---------------|
| `configured` | Whether `REDIS_URL` env var is set |
| `connected` | Whether Redis is currently reachable |
| `lastError` | Raw ioredis error strings — can contain internal hostnames, ports, connection strings, auth errors (e.g., `connect ECONNREFUSED 10.0.1.5:6379`) |
| `rollup.lastSuccessDate` | Operational cadence |
| `rollup.stale` | Whether the system is degraded |

The `lastError` field is the primary concern. `RedisService.getLastError()`
(`src/redis/redis.service.ts:55-57`) stores raw ioredis error messages that routinely
include internal infrastructure details.

### Options

1. **Return boolean only** (recommended) — change response to `{ ok: boolean }`. K8s probes
   only need HTTP 200/503. Simplest, eliminates all leakage. ~10 min.
2. **Add `@UseGuards(AnalyticsGuard)`** — one decorator, consistent with other endpoints.
   Breaks unauthenticated monitoring if any exists. ~2 min.
3. **Strip sensitive fields for unauthenticated callers** — keep boolean fields public,
   gate `lastError` and `rollup` behind guard. More complex. ~30 min.

### Fix

`src/analytics/analytics.controller.ts:73-90` — apply option 1 or 2.

---

## 3. Redis Cache Key Leaks Plaintext IP

**Priority: Low** | Effort: 1 line | File: `src/analytics/analytics.service.ts:399`

### Problem

```typescript
const cacheKey = `${KEY_PREFIX}:ip_country:${normalizedIp}`;
```

The country-lookup cache stores plaintext IPs as Redis keys with 30-day TTL. Anyone with
Redis access can `KEYS analytics:ip_country:*` to enumerate all resolved visitor IPs.

### Risk

Low. Redis is internal-only (configured via `REDIS_URL`). Exploitable only with
infrastructure access. But defense-in-depth argues against storing plaintext IPs in cache
keys when hashing is trivial.

### Fix

```typescript
const cacheKey = `${KEY_PREFIX}:ip_country:${this.hashIp(normalizedIp)}`;
```

One-line change. If /24 truncation is adopted in `hashIp()`, this also improves cache hit
rate (same /24 always maps to same country). Performance impact: ~200-500ns SHA-256 vs
~100-500us Redis GET — negligible (<0.1%).

**Bundle with fix 1.**

---

## 4. Timing-Unsafe API Key Comparison

**Priority: Low** | Effort: 15 min | Files: `analytics.guard.ts:28`, `admin.guard.ts:26`

### Problem

Both guards use `===` for API key comparison:

```typescript
// analytics.guard.ts:28
if (headerKey === envKey) return true;

// admin.guard.ts:26
return headerKey === envKey ? envKey : null;
```

JavaScript `===` short-circuits on the first differing character, creating a timing
side-channel (~1-5ns per matching character).

### Risk Assessment

**Practically unexploitable over HTTPS.** Network jitter (1-10ms) buries the nanosecond
signal under 6 orders of magnitude of noise. However:

- CVE-2025-59425 (vLLM, CVSS 7.5 High) was issued for this exact pattern
- CWE-208 (Observable Timing Discrepancy) is a recognized weakness
- OWASP recommends constant-time comparison for all secrets
- James Kettle (PortSwigger) demonstrated practical web timing attacks at Black Hat 2024
  using statistical analysis across thousands of requests

### Fix

```typescript
import { timingSafeEqual } from 'crypto';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // constant time even on length mismatch
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
```

Already tracked in AUDIT.md as Phase 2 item 13/28. **Defer to Phase 2.**

---

## 5. Error Leakage in latest-members

**Priority: Low** | Effort: 10 min | File: `src/analytics/analytics.controller.ts:142-146`

### Problem

```typescript
catch (e) {
  const message = e instanceof Error ? e.message : 'Failed to fetch latest members';
  return { ok: false, error: message };
}
```

Returns raw `e.message` to the API caller. Prisma errors can contain database hostnames,
connection strings, SQL fragments, table/column names, and internal file paths.

CWE-209 (Generation of Error Message Containing Sensitive Information) covers this pattern.
OWASP Top Ten 2021 A04 (Insecure Design) maps to it. SAST tools (Veracode, CodeQL) flag it.

### Mitigating Factors

- Endpoint is behind `@UseGuards(AnalyticsGuard)` — attacker needs the API key
- The only `e.message` return pattern in a controller across the entire codebase

### Fix

**Must add logging first** — the analytics controller has no `Logger` instance. Without it,
genericizing the error message silently loses debugging visibility.

```typescript
private readonly logger = new Logger(AnalyticsController.name);

// In catch block:
this.logger.error('Failed to fetch latest members', e instanceof Error ? e.stack : e);
return { ok: false, error: 'Failed to fetch latest members' };
```

---

## 6. Dead Export `const dynamic`

**Priority: Trivial** | Effort: 1 min | File: `src/analytics/analytics.service.ts:141`

### Problem

```typescript
export const dynamic = 'force-dynamic';
```

This is a Next.js App Router route segment config that tells the framework to disable static
rendering. NestJS has no mechanism to recognize or act on this export. It is inert dead code.

### Evidence

- Zero imports anywhere in the codebase (confirmed by grep + ts-unused-exports)
- Not referenced in any config, build tool, or test
- Git blame: introduced in commit `8d8b7000` by Arbaz (2026-03-05) with message `.` —
  copy-pasted from a Next.js reference project
- Later touched in `82873d16` ("fix lint issues") only to change quote style

### Fix

Delete the line.

---

## Additional Dead Code (discovered during audit)

Not part of the original 6 fixes but surfaced by the consistency agent:

| Item | File | Details |
|------|------|---------|
| `api.controller.ts` + `data.service.ts` | `src/api.controller.ts`, `src/data.service.ts` | Dead code per CLAUDE.md. Not in any module. 29KB total. |
| `cache-control.ts` | `src/common/cache-control.ts` | 91 lines, exports `EdgeCachePolicy`, `applyPublicEdgeCache`, `applyAnonymousEdgeCache`. Zero imports anywhere. Another Next.js/CDN artifact. |
| `ReviewStatusQueryDto` | `src/admin/dto/review-status-query.dto.ts` | Re-exported from barrel `admin/dto/index.ts` but never imported by any controller, service, or test. |
| Redundant global module imports | `analytics.module.ts:11`, `admin.module.ts:12`, `users.module.ts:9` | Import `PrismaModule` / `ConfigModule` which are `@Global()`. Harmless at runtime (NestJS deduplicates) but violates CLAUDE.md convention. |

---

## Mechanical Baseline (2026-03-28)

All checks pass at HEAD (fd8bd12):

```
Tests:     PASS — 608 passed, 39 suites
Build:     PASS
Typecheck: PASS (tsc --noEmit)
Lint:      PASS
```
