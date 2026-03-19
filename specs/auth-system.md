---
Status: Implemented
Last verified: 2026-03-19
---

# Auth System

> Source of truth: `src/auth/auth.service.ts` and `src/main.ts` (CSRF middleware).
> If this spec contradicts the code, the code is correct — update this spec.

<!-- Review when src/auth/ changes -->

## Overview

Cryptoli uses JWT tokens stored in HTTP-only cookies for session management.
Authentication flows through a login/register pipeline that validates with Zod,
hashes with bcrypt, creates a DB-backed session, and sets a signed cookie.
Three guards control route access. CSRF protection runs as Express middleware
in `main.ts`, not as a NestJS guard.

## Non-Goals

- OAuth / social login providers
- Token refresh rotation (sessions are 7-day fixed expiry)
- Per-route CORS configuration (CORS is global in `main.ts`)
- Rate limiting logic beyond the auth-specific throttle override

## Key Patterns

### Auth Flow (Login/Register)

1. Validate body with Zod (raw `body: unknown` then `.parse()`) — schemas in `src/common/utils.ts`
2. Hash password with bcrypt (10 rounds)
3. Create session in DB with SHA-256 hashed token and 7-day expiry
4. Set HTTP-only cookie: `res.cookie('session', token, { httpOnly: true, sameSite, secure })`
5. `sameSite` is `'none'` in production with non-localhost origins (cross-origin Vercel → Railway)

### Guard Resolution

Three guards — use the correct one:

- **`@UseGuards(AuthGuard)`** — user MUST be authenticated (401 if not). Sets `req.user` to `SessionUser`.
- **`@UseGuards(OptionalAuthGuard)`** — anonymous allowed. Sets `req.user` to `SessionUser` or `null`.
- **`@UseGuards(AdminGuard)`** — admin only. Checks `X-Admin-Key` header or admin JWT.

Without any guard, `req.user` is `undefined` (not `null`). If you need the user identity, you need a guard.

Type-cast request as `Request & { user: SessionUser }` — there is no decorator.

**SessionUser shape:** `{ id, email, username, role, avatar, bio, verified, reputation }`

### Token Resolution Order

`getSessionTokenFromRequest` resolves in strict order:

1. `Authorization: Bearer <token>` header
2. `req.cookies.session`
3. Manual cookie parse from raw header (fallback)

`getSessionFromToken` validates by:

1. `jwt.verify()` (signature + expiry)
2. DB lookup by hashed token with expiry check — session is DB-verified, not just JWT-verified

### CSRF Protection

CSRF is Express middleware in `main.ts`, not a NestJS guard:

- Fires on POST/PUT/PATCH/DELETE only when `session=` cookie is present
- Checks Origin (or Referer as fallback) against configured CORS origins
- Returns 403 directly — **bypasses NestJS AllExceptionsFilter**

### Admin Auth

Separate system from user auth:

- `AdminGuard` checks: `X-Admin-Key` header, OR `?key=` query param, OR JWT with `{ type: 'admin' }` claim
- Admin JWT issued by `AdminAuthService.login()` using `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` env vars
- `ADMIN_API_KEY` and `ANALYTICS_API_KEY` are completely separate keys

### Rate Limiting

Auth endpoints override the global throttle to **5 req/60s** for both tiers:

```ts
@Throttle({ short: { limit: 5, ttl: 60000 }, long: { limit: 5, ttl: 60000 } })
```

Both `short` and `long` tiers are set identically (`ttl` is in milliseconds).
Maintain this on any new auth endpoints to mitigate credential stuffing.

## Verification

```
grep -rn 'AuthGuard\|OptionalAuthGuard\|AdminGuard' src/
grep -rn '@Throttle' src/auth/
grep -rn 'getSessionTokenFromRequest\|getSessionFromToken' src/auth/
grep -rn 'csrf\|CSRF\|sameSite' src/main.ts
```
