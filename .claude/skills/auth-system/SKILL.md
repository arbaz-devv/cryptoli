---
name: auth-system
description: "Full auth flow: JWT cookies, session management, CSRF protection, guard resolution, admin auth"
---

> Source of truth: `src/auth/auth.service.ts` and `src/main.ts` (CSRF middleware). If this skill contradicts the code, the code is correct.

## Auth Flow (End-to-End)

**Login/Register** (`POST /api/auth/login`, `POST /api/auth/register`):
1. Validate body with Zod (raw `body: unknown` → `.parse()`) — schemas in `src/common/utils.ts`
2. Hash password with bcrypt (10 rounds)
3. Create session: `prisma.session.create({ data: { userId, token, expiresAt } })` with JWT signed for 7 days
4. Set HTTP-only cookie: `res.cookie('session', token, { httpOnly: true, sameSite, secure })`
5. SameSite is `'none'` in production with non-localhost origins (cross-origin deployments like Vercel → Railway)

**Guard Resolution** (AuthGuard / OptionalAuthGuard):
1. `getSessionTokenFromRequest(req)` checks in order: `Authorization: Bearer <token>` → `req.cookies.session` → manual cookie parse
2. `getSessionFromToken(token)` does: `jwt.verify()` then `prisma.session.findUnique({ where: { token }, include: { user: true } })` with DB expiry check
3. Sets `req.user` as `SessionUser`: `{ id, email, username, role, avatar, bio, verified, reputation }`

**Admin Auth** (separate system):
- `AdminGuard` checks `X-Admin-Key` header (or `?key=` query) matching env vars, OR JWT with `{ type: 'admin' }` claim
- Admin JWT issued by `AdminAuthService.login()` using `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH`

**CSRF Protection** (middleware in main.ts, not a NestJS guard):
- Fires on POST/PUT/PATCH/DELETE only when `session=` cookie is present
- Checks Origin (or Referer fallback) against configured CORS origins
- Returns 403 directly — bypasses NestJS exception filter
