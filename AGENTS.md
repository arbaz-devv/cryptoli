# Cryptoli

NestJS 11 backend for a cryptocurrency/fintech platform. TypeScript, Prisma ORM + PostgreSQL, Redis, Socket.IO.

## Specifications

**IMPORTANT:** Before implementing any feature, consult the specifications
in [specs/README.md](specs/README.md).

- **Assume NOT implemented.** Many specs describe planned features that may
  not yet exist in the codebase.
- **Check the codebase first.** Before concluding something is or isn't
  implemented, search the actual code. Specs describe intent; code
  describes reality.
- **Use specs as guidance.** When implementing a feature, follow the design
  patterns, types, and architecture defined in the relevant spec.

## Commands

| Purpose   | Command                              |
|-----------|--------------------------------------|
| Dev       | `npm run start:dev`                  |
| Build     | `npm run build`                      |
| Test      | `npm run test`                       |
| Test one  | `npx jest path/to/file.spec.ts`      |
| Test cov  | `npm run test:cov`                   |
| Test intg | `npm run test:integration`           |
| Test e2e  | `npm run test:e2e`                   |
| Test all  | `npm run test:all`                   |
| Typecheck | `npx tsc --noEmit`                   |
| Lint      | `npm run lint`                       |
| Format    | `npm run format`                     |
| Migrate   | `npx prisma migrate dev`             |
| Generate  | `npx prisma generate`               |

## Boundaries

**Always:** Run tests before marking a task done. Search the codebase before
creating new code. Run `prisma migrate dev` then `prisma generate` after any
schema change. Write or update tests at all applicable tiers for code you
create or modify (see Testing section below). Register new feature modules
in `app.module.ts` imports.

**Ask first:** Changes to specs/ documents. Dependency major version bumps.
New packages or modules. Cascade-delete additions (User cascades to 14+ tables).

**Never:** Modify or import `src/api.controller.ts` or `src/data.service.ts`
(dead code, not registered in AppModule). Commit credentials or .env files.
Push directly to main. Throw `AppError` directly. Modify migration files by hand.

## Architecture

```
src/
├── main.ts              # Bootstrap: HTTP, Socket.IO, Helmet, CORS, CSRF, ValidationPipe
├── app.module.ts        # Root module — register all feature modules here
├── common/              # Shared errors (AppError hierarchy), Zod schemas, exception filter
├── config/              # ConfigModule (global) — env validation via Zod
├── prisma/              # PrismaModule (global) — PrismaService singleton
├── redis/               # RedisModule (global) — graceful no-op when REDIS_URL absent
├── socket/              # SocketModule (global) — manual Socket.IO on globalThis.__socketIO
├── auth/                # JWT cookies, session management, guards, rate-limited 5/60s
├── admin/               # Admin CRUD, AdminGuard, class-validator DTOs, in-process caching
├── analytics/           # Redis-backed analytics, AnalyticsGuard (fail-closed)
├── reviews/             # Review CRUD, voting with $transaction recount, socket events
├── comments/            # One-level threaded comments (self-relation via parentId)
├── complaints/          # Complaints, voting, company replies
├── companies/           # Company/Product CRUD, follows, slug-based lookup
├── users/               # User profiles, follows, Redis profile cache
├── feed/                # Aggregated social feed
├── search/              # Full-text search
├── trending/            # Time-windowed rankings
└── notifications/       # DB notifications, socket emit, web push (forwardRef with AuthModule)
prisma/
└── schema.prisma        # Database schema — PostgreSQL
```

Entry: `src/main.ts` | Schema: `prisma/schema.prisma` | Config: `src/config/env.schema.ts`

## Conventions

**Global modules** — ConfigModule, PrismaModule, RedisModule, SocketModule are
available everywhere. Never import them in feature modules. If your module
needs AuthGuard/OptionalAuthGuard, import AuthModule. If it needs
NotificationsService, import NotificationsModule.

**Validation (two patterns)** — Admin module: class-validator DTOs with
`@Body() dto: Type`. Auth/Reviews/Comments/Complaints/Feed: raw
`@Body() body: unknown` + Zod `.parse()` in service/controller. Zod schemas
live in `src/common/utils.ts`. Check which pattern the target module uses.

**Errors** — Use `NotFoundError` from `src/common/errors.ts` for 404s. Use
NestJS built-in exceptions for others. Never throw `AppError` directly.

**Votes** — Must use `prisma.$transaction` with recount from DB. Never use
`{ increment: 1 }` — it drifts under concurrency. See `ReviewsService.vote()`.

**Socket emit ordering** — Emit AFTER the DB transaction, never inside it.
Create notifications AFTER socket emissions. SocketService no-ops when
`globalThis.__socketIO` is undefined (tests, pre-bootstrap).

**Review status filtering** — Public review listing always filters by APPROVED
status. The status query param is silently discarded in `ReviewsController.list()`.
Only admin routes respect status filters.

**Auth circular dependency** — AuthModule and NotificationsModule use
`forwardRef()` on both sides. Do not add direct imports between them.

**Profile cache** — Redis-backed. After mutations affecting profile data in
UsersService, call `invalidateProfileCache(username)`.

## Specs Index

> When working on a topic below, read the corresponding spec before changes.

| When you're working on...              | Read                            |
|----------------------------------------|---------------------------------|
| Auth, guards, sessions, CSRF           | `specs/auth-system.md`          |
| Database schema, relations, cascades   | `specs/data-model.md`           |
| Voting, reactions, helpful marks       | `specs/voting-system.md`        |
| Socket.IO, real-time events            | `specs/socket-architecture.md`  |
| Testing, coverage, isolation           | `specs/testing-strategy.md`     |

Full index with summaries: [specs/README.md](specs/README.md)

## Testing

**Three-tier test architecture.** Every feature or modification must include
tests at all applicable tiers. Read `specs/testing-strategy.md` for full
conventions, patterns, and isolation guarantees.

| Tier | Location | What it tests | When required |
|------|----------|--------------|---------------|
| **Unit** | `src/**/*.spec.ts` (co-located) | Business logic with mocked deps | Every service, guard, pipe, filter, utility |
| **Integration** | `test/integration/*.spec.ts` | Real DB queries, transactions, constraints | Voting/recount, cascades, session lifecycle, follows |
| **E2E** | `test/e2e/*.e2e-spec.ts` | Full HTTP stack via supertest | Every new API endpoint or route change |

**When implementing a new feature, you must:**
1. Write unit tests for the service (mock Prisma, Redis, Socket via `test/helpers/`)
2. Write integration tests if the feature involves transactions, constraints, or cascades (use real PostgreSQL via TestContainers)
3. Write or update e2e tests for any new or changed HTTP endpoints
4. Run `npm run test:all` (unit + integration + e2e) before marking done
5. Verify `npm run test:cov` passes the coverage thresholds

**Shared test infrastructure** — use the helpers in `test/helpers/`:
- `prisma.mock.ts` — Prisma mock factory (all 19 models)
- `redis.mock.ts` — Redis mock with ready/not-ready toggle
- `socket.mock.ts` — Socket mock with all 7 emit methods
- `auth.helpers.ts` — session user factory, JWT helpers, mock request/context
- `factories.ts` — test data factories for integration/e2e (createTestUser, etc.)
- `setup-app.ts` — e2e app bootstrap replicating main.ts middleware

**Test isolation** — integration and e2e tests use TestContainers (disposable
PostgreSQL + Redis). Tests must never connect to real services. See
`specs/testing-strategy.md` → "Isolation Guarantees" for the full safety model.

## Git

Format: `type(scope): description` — e.g., `feat(reviews): add pagination`,
`fix(auth): handle expired session edge case`.

## Environment

Copy `.env.example` to `.env`. Required: `DATABASE_URL`, `JWT_SECRET` (32+
chars in prod), `CORS_ORIGIN`. Optional: `REDIS_URL` (Redis features no-op
when absent), `ADMIN_API_KEY`, `ANALYTICS_API_KEY`, `ADMIN_EMAIL`,
`ADMIN_PASSWORD_HASH`, `TRUST_PROXY`, `PORT`.
