# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

NestJS 11 backend for a cryptocurrency/fintech platform. TypeScript, Prisma ORM + PostgreSQL, Redis, Socket.IO.

## Commands

```bash
npm run start:dev              # Dev server with watch
npm run build                  # Compile to dist/
npm run test                   # Unit tests (Jest, **/*.spec.ts)
npm run test:e2e               # E2E tests (**/*.e2e-spec.ts)
npm run lint                   # ESLint with auto-fix
npm run format                 # Prettier
npx prisma migrate dev         # Apply migrations
npx prisma generate            # Regenerate client after schema changes
```

## Architecture

Modular monolith. Global modules (ConfigModule, PrismaModule, RedisModule, SocketModule) are available everywhere — never import them in feature modules. Feature modules (Auth, Reviews, Complaints, Comments, Companies, Users, Feed, Search, Trending, Notifications, Analytics, Admin) each follow the controller -> service -> Prisma pattern. Bootstrap in `src/main.ts` sets up HTTP, Socket.IO, Helmet, CORS, CSRF, global ValidationPipe, and AllExceptionsFilter.

Database schema in `prisma/schema.prisma`. Reactions are polymorphic (nullable FKs to Review/Post/Comment/Complaint). Comments support one-level threading via self-relation.

## Critical Constraints

- **Two validation patterns coexist.** Admin module uses class-validator DTOs. Auth/Reviews/Comments/Complaints use raw `body: unknown` + Zod `.parse()` in service/controller. Check which pattern the module uses before adding endpoints.
- **Vote mutations must use `$transaction` with recount** — `{ increment: 1 }` drifts under concurrent writes. Always recount from DB inside the transaction. See `ReviewsService.vote()` for the correct pattern.
- **`src/api.controller.ts` and `src/data.service.ts` are dead files.** Not registered in AppModule. Do not modify, reference, or import them.
- **Public review listing always filters by APPROVED status** (intentional: content moderation requires admin approval before public display). The `status` query param is silently discarded in `ReviewsController.list()`. Only admin routes respect status filters.
- **AuthModule <-> NotificationsModule is a circular dependency** resolved with `forwardRef()` on both sides. Do not add direct imports between these modules.
- **Socket.IO is manual, not @WebSocketGateway.** Set up in `main.ts`, stored on `globalThis.__socketIO`. SocketService methods no-op when the server isn't initialized (including in tests).
- **Profile cache (Redis) must be invalidated manually.** If you add mutations affecting profile data in UsersService, call `invalidateProfileCache(username)`.
- **Search before writing.** Before creating new code, search the codebase to confirm the functionality doesn't already exist — don't assume not implemented.
- **Write tests for what you change.** Write or update tests for code you create or modify. Tests must pass before the task is complete.

## Errors

Use `NotFoundError` from `src/common/errors.ts` for 404s. Use NestJS built-in exceptions (`BadRequestException`, `ConflictException`, `UnauthorizedException`) for other HTTP errors. Never throw `AppError` directly.

## Commit Messages

Write descriptive commit messages that explain what changed. Format: `type(scope): description` (e.g., `feat(reviews): add pagination to list endpoint`, `fix(auth): handle expired session edge case`).

## Environment

Copy `.env.example` to `.env`. Required: `DATABASE_URL`, `JWT_SECRET` (32+ chars in prod), `CORS_ORIGIN`. Optional: `REDIS_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`. Redis is gracefully optional — all Redis-dependent features no-op when `REDIS_URL` is absent.

## Harness

Path-scoped rules in `.claude/rules/` trigger when you touch matching files. Domain knowledge in `.claude/skills/` loads on demand. Hooks in `.claude/settings.json` enforce quality gates: typecheck on every file edit, build validation on session start, lint+test on session stop.
