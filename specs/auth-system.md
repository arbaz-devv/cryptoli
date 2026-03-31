---
Status: Implemented
Last verified: 2026-03-31
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

## Endpoint Reference

| Method | Path | Guard | Throttle | Validation |
|--------|------|-------|----------|------------|
| GET | `/api/auth/me` | None | Default | None |
| GET | `/api/auth/check-username` | None | Default | Manual (length, alphanumeric) |
| GET | `/api/auth/username-suggestions` | None | Default | `base` query param |
| PATCH | `/api/auth/me` | `AuthGuard` | Default | Zod (`updateProfileSchema`) |
| POST | `/api/auth/register` | None | 5/60s | Zod (`registerSchema`) |
| POST | `/api/auth/login` | None | 5/60s | Zod (`loginSchema`) |
| POST | `/api/auth/logout` | None | Default | None |
| POST | `/api/auth/change-password` | `AuthGuard` | Default | Zod (`changePasswordSchema`) |

`@UseInterceptors(AnalyticsInterceptor)` is applied at the class level.

## Key Patterns

### Auth Flow (Login/Register)

1. Validate body with Zod (raw `body: unknown` then `.parse()`) — schemas in `src/common/utils.ts`
2. Hash password with bcrypt (10 rounds)
3. Create session in DB with SHA-256 hashed token and 7-day expiry
4. Set HTTP-only cookie via `sessionCookieOptions()`: `{ httpOnly: true, sameSite, secure, path: '/', maxAge: 7d }`
5. `sameSite` is `'none'` in production with non-localhost origins; `secure` is always `true` in production

### Guard Resolution

Three guards — use the correct one:

- **`@UseGuards(AuthGuard)`** — user MUST be authenticated (401 if not). Sets `req.user` to `SessionUser`.
- **`@UseGuards(OptionalAuthGuard)`** — anonymous allowed. Sets `req.user` to `SessionUser` or `null`.
- **`@UseGuards(AdminGuard)`** — admin only. Checks `X-Admin-Key` header or admin JWT. (No query param support.)

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

- `AdminGuard` checks: `X-Admin-Key` header, OR JWT with `{ type: 'admin' }` claim
- Admin JWT issued by `AdminAuthService.login()` using `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` env vars
- `ADMIN_API_KEY` and `ANALYTICS_API_KEY` are completely separate keys

### Rate Limiting

Login and register endpoints override the global throttle to **5 req/60s** for both tiers:

```ts
@Throttle({ short: { limit: 5, ttl: 60000 }, long: { limit: 5, ttl: 60000 } })
```

Both `short` and `long` tiers are set identically (`ttl` is in milliseconds).
Other auth endpoints (me, check-username, logout, change-password, etc.) use
the global throttle defaults.

### Session Enrichment

`createSession(userId, meta?: SessionMetadata)` captures request context at
login/register/password-change. The `SessionMetadata` interface (`auth.service.ts`)
includes: `ip`, `userAgent`, `country?`, `timezone?`,
`trigger: 'login' | 'register' | 'password_change'`.

The Session model stores parsed fields: `ip`, `ipHash` (SHA-256), `userAgent`,
`device`, `browser`, `os` (parsed via `getDeviceAndBrowser()` from
`src/common/ua.ts`), `country`, `timezone`, `trigger`.

`AuthController.extractSessionMeta(req, trigger)` extracts context using
`getClientIp()` and `getCountryHint()` from `src/analytics/ip-utils.ts`.

### Analytics Integration

`@UseInterceptors(AnalyticsInterceptor)` is applied at the controller level.
Auth events tracked: `user_login`, `user_register`, `user_logout`,
`password_change`. AnalyticsModule is imported in AuthModule (one-directional,
no circular dependency). `AnalyticsService` is injected with `@Optional()`.

### Registration Context

`createUser()` accepts optional `registrationIp` and `registrationCountry`,
persisted to the User model for analytics.

### Profile Update

`PATCH /api/auth/me` accepts `{ username?, bio? }` validated by Zod
(`updateProfileSchema`). Username uniqueness enforced via Prisma P2002 error
handling. Returns `{ user }` with updated `SessionUser` shape.

### Username Suggestions

`GET /api/auth/username-suggestions?base=` generates available username
variants. Works for both authenticated and anonymous users (optionally
resolves the current user via session token).

### Password Change Side Effects

`POST /api/auth/change-password` triggers three side effects beyond updating
the password hash:

1. **Session rotation** — creates a new session (trigger: `password_change`)
   and deletes all other sessions for the user
2. **Notification** — creates a `MENTION`-type notification with title
   "Password changed" (note: uses `MENTION` type, not a dedicated security type)
3. **Analytics** — tracks `password_change` event

### GeoIP Fallback in Session Creation

`createSession()` uses `GeoipService.lookup(meta.ip)` as a second-pass
fallback for `country` and `timezone`, beyond what `extractSessionMeta`
provides from CDN headers. The fallback chains differ:

- **Country**: `meta.country` (CDN header) → `geoResult.country` (GeoIP) → `null`
- **Timezone**: `geoResult.timezone` (GeoIP) → `meta.timezone` (request) → `null`

Country prefers the CDN header; timezone prefers the GeoIP lookup.

## Verification

```
grep -rn 'AuthGuard\|OptionalAuthGuard\|AdminGuard' src/
grep -rn '@Throttle' src/auth/
grep -rn 'getSessionTokenFromRequest\|getSessionFromToken' src/auth/
grep -rn 'csrf\|CSRF\|sameSite' src/main.ts
```
