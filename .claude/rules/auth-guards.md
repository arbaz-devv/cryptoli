---
paths:
  - "src/**/controllers/**"
  - "src/**/*.controller.ts"
---
Three guards exist — use the right one:
- `@UseGuards(AuthGuard)` — user MUST be authenticated (401 if not). Sets `req.user` to SessionUser.
- `@UseGuards(OptionalAuthGuard)` — anonymous allowed. Sets `req.user` to SessionUser or `null`.
- `@UseGuards(AdminGuard)` — admin only. Checks X-Admin-Key header or admin JWT.

Without any guard, `req.user` is `undefined` (not `null`). If you need the user identity, you need a guard.

Type-cast request as `Request & { user: SessionUser }` — there is no decorator.
