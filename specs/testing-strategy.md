# Testing Strategy

> **Status:** Planned (2026-03-19)
> **Source of truth:** This spec defines the testing conventions. The test files themselves are the source of truth for what is currently tested.

## Overview

Complete test coverage for the Cryptoli NestJS backend via three tiers of tests, each catching a distinct class of bug. Starting baseline: 11.13% statement coverage, 45 tests across 10 spec files.

| Tier | What it catches | Database | HTTP | Speed |
|------|----------------|----------|------|-------|
| **Unit** | Logic bugs (wrong branch, wrong calculation, wrong condition) | Mocked | No | Fast (~5s) |
| **Integration** | Query bugs (wrong `where`, broken transaction, missing cascade) | Real PostgreSQL | No | Medium (~30s) |
| **E2E** | Wiring bugs (missing guard, wrong pipe, CSRF misconfigured) | Real PostgreSQL | Yes (supertest) | Slow (~60s) |

## Test Infrastructure Requirements

### External Dependencies

| Dependency | Required For | Test Env | Provisioned By |
|-----------|-------------|----------|----------------|
| PostgreSQL | Integration + E2E | Disposable container | TestContainers |
| Redis | Analytics integration tests | Disposable container | TestContainers |
| Docker | Running TestContainers | Must be available | Developer / CI |

### Environment Configuration

**`.env.test`** — loaded by integration and e2e tests. Unit tests do not read env.

```env
NODE_ENV=test
DATABASE_URL=                          # Overwritten at runtime by TestContainers
JWT_SECRET=test-jwt-secret-at-least-32-characters-long
CORS_ORIGIN=http://localhost:3000
PORT=0                                 # Let OS pick (avoids port conflicts)
ADMIN_API_KEY=test-admin-key
ANALYTICS_API_KEY=test-analytics-key
ADMIN_EMAIL=admin@test.com
ADMIN_PASSWORD_HASH=                   # Generated in globalSetup from 'testpassword'
# REDIS_URL=                           # Overwritten at runtime by TestContainers
# VAPID keys intentionally absent — push service no-ops in tests
```

`DATABASE_URL` and `REDIS_URL` are injected dynamically by the TestContainers global setup — they point to the ephemeral containers. They must not be hardcoded.

### Jest Configurations

**Three jest configs, one per tier:**

| Config | Runs | `testRegex` | `rootDir` |
|--------|------|-------------|-----------|
| `package.json` (inline) | Unit tests | `src/.*\\.spec\\.ts$` | `src` |
| `test/jest-integration.json` | Integration tests | `test/integration/.*\\.spec\\.ts$` | `.` |
| `test/jest-e2e.json` | E2E tests | `test/e2e/.*\\.e2e-spec\\.ts$` | `.` |

Integration and e2e configs share a `globalSetup` that starts TestContainers and a `globalTeardown` that stops them.

### npm Scripts

```json
{
  "test": "jest",
  "test:cov": "jest --coverage",
  "test:integration": "jest --config test/jest-integration.json",
  "test:e2e": "jest --config test/jest-e2e.json",
  "test:all": "npm test && npm run test:integration && npm run test:e2e"
}
```

### New devDependencies

```
@testcontainers/postgresql    — disposable PostgreSQL container
testcontainers                — core TestContainers library
nock                          — HTTP interception (blocks outbound requests)
```

---

## Isolation Guarantees

**Tests must NEVER touch real services.** No fallback, no hope-it-works. The architecture makes it structurally impossible for tests to connect to anything outside disposable TestContainers.

### Threat Model

| Vector | Risk | How it happens |
|--------|------|---------------|
| PrismaClient auto-loads `.env` | **CRITICAL** — writes to real DB | `@prisma/client` reads `.env` from project root at construction time, even in tests |
| `process.env.REDIS_URL` from `.env` | **HIGH** — writes to real Redis | `redis.service.ts` reads directly from `process.env`, not ConfigService |
| `fetch('https://ipwho.is/...')` | **MEDIUM** — outbound HTTP | `analytics.service.ts:363` calls external API for IP geolocation |
| `webPush.sendNotification()` | **LOW** — sends real push | Only fires when `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` are in env |
| `import 'dotenv/config'` in `main.ts` | **LOW in tests** — only imported in production bootstrap | `main.ts` is not imported by test modules, but caution required |

### Primary Defense: Explicit Dependency Injection

The primary isolation mechanism is **never reading `process.env` in test context**. Instead, tests construct dependencies with explicit URLs from TestContainers:

**Integration tests** — construct services directly, no env involved:
```typescript
// The URL comes from the container object, not process.env
const prisma = new PrismaClient({ datasourceUrl: pg.getConnectionUri() });
const service = new ReviewsService(prisma, socketMock, notificationsMock);
```

**E2E tests** — override providers explicitly:
```typescript
const module = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(PrismaService)
  .useValue(testPrisma)       // ← constructed from TestContainers URL, not env
  .overrideProvider(RedisService)
  .useValue(testRedis)         // ← constructed from TestContainers URL, not env
  .compile();
```

This means `.env` can contain anything — production credentials, staging URLs, whatever — and tests will never read it. The connection URL is passed directly from the container to the client, bypassing `process.env` entirely.

### globalSetup: Three-Phase Boot Sequence

`test/helpers/test-db.setup.ts` runs before ANY test file is loaded. It follows a strict three-phase sequence. If any phase fails, no tests run.

```typescript
export default async function globalSetup() {
  // ── Phase 1: Provision ──────────────────────────────────────────
  // Start disposable containers. These are the ONLY external services
  // tests will ever connect to.

  const pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('cryptoli_test')
    .start();

  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  // Run migrations against the test database
  const databaseUrl = pg.getConnectionUri();
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  // Construct test clients with EXPLICIT URLs (not from process.env)
  const testPrisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const testRedisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  // ── Phase 2: Validate ──────────────────────────────────────────
  // Verify infrastructure is correct BEFORE any test runs.
  // This is the gate — if validation fails, zero tests execute.

  const errors: string[] = [];

  // 2a. Database is reachable and migrated
  try {
    const tables = await testPrisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    const names = tables.map(t => t.tablename);
    for (const required of ['User', 'Review', 'Session', 'Comment', 'Complaint',
                            'Company', 'HelpfulVote', 'Notification', 'Follow']) {
      if (!names.includes(required)) {
        errors.push(`Missing table "${required}" — prisma migrate deploy may have failed`);
      }
    }
  } catch (e) {
    errors.push(`Cannot connect to test PostgreSQL: ${e.message}`);
  }

  // 2b. Database is empty (no stale data from a crashed prior run)
  try {
    const count = await testPrisma.user.count();
    if (count > 0) {
      errors.push(`Test database has ${count} users — expected empty. Stale container?`);
    }
  } catch (e) {
    errors.push(`Cannot query test database: ${e.message}`);
  }

  // 2c. Redis is reachable
  try {
    const testRedisClient = new Redis(testRedisUrl);
    const pong = await testRedisClient.ping();
    if (pong !== 'PONG') errors.push(`Redis ping returned "${pong}" — expected PONG`);
    await testRedisClient.quit();
  } catch (e) {
    errors.push(`Cannot connect to test Redis: ${e.message}`);
  }

  // 2d. Connections are localhost (structural guarantee, not env-dependent)
  if (!isLocalhost(pg.getHost())) {
    errors.push(`PostgreSQL host is "${pg.getHost()}" — expected localhost`);
  }
  if (!isLocalhost(redis.getHost())) {
    errors.push(`Redis host is "${redis.getHost()}" — expected localhost`);
  }

  // 2e. Dangerous credentials are NOT in the environment
  const MUST_BE_ABSENT = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
  for (const v of MUST_BE_ABSENT) {
    if (process.env[v]) {
      errors.push(`${v} is set — push notifications could fire against real endpoints`);
    }
  }

  // 2f. GATE: if any check failed, abort with full diagnostic
  if (errors.length > 0) {
    await testPrisma.$disconnect();
    await pg.stop();
    await redis.stop();
    throw new Error(
      '\n╔══════════════════════════════════════════════════════╗\n' +
      '║  TEST INFRASTRUCTURE VALIDATION FAILED              ║\n' +
      '╠══════════════════════════════════════════════════════╣\n' +
      errors.map((e, i) => `║  ${i + 1}. ${e}`).join('\n') + '\n' +
      '╠══════════════════════════════════════════════════════╣\n' +
      '║  No tests will run. Fix the above issues first.     ║\n' +
      '╚══════════════════════════════════════════════════════╝'
    );
  }

  // ── Phase 3: Expose ────────────────────────────────────────────
  // Make validated infrastructure available to test files.
  // Tests access these via getTestPrisma() / getTestRedisUrl() helpers.

  // Clean up validation client (tests get their own)
  await testPrisma.$disconnect();

  // Store on globalThis for test files and teardown
  (globalThis as any).__TEST_PG_CONTAINER__ = pg;
  (globalThis as any).__TEST_REDIS_CONTAINER__ = redis;
  (globalThis as any).__TEST_DATABASE_URL__ = databaseUrl;
  (globalThis as any).__TEST_REDIS_URL__ = testRedisUrl;

  // Set env vars as SECONDARY path (for AppModule bootstrap in e2e).
  // The primary path is always explicit injection, but AppModule reads
  // process.env internally, so we set these to the container URLs.
  // DANGEROUS_VARS are cleared first to prevent any .env leakage.
  const DANGEROUS_VARS = [
    'DATABASE_URL', 'REDIS_URL',
    'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
  ];
  for (const v of DANGEROUS_VARS) delete process.env[v];

  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = testRedisUrl;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
  process.env.CORS_ORIGIN = 'http://localhost:3000';
  process.env.ADMIN_API_KEY = 'test-admin-key';
  process.env.ANALYTICS_API_KEY = 'test-analytics-key';
  process.env.ADMIN_EMAIL = 'admin@test.com';
  process.env.ADMIN_PASSWORD_HASH = hashSync('testpassword', 10);

  // Block all outbound HTTP — last line of defense for unknown externals
  nock.disableNetConnect();
  nock.enableNetConnect((host) =>
    /^(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(host)
  );
}

function isLocalhost(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}
```

### Test File Access Pattern

Test files never construct their own PrismaClient or read env vars. They use validated helpers:

```typescript
// test/helpers/test-db.utils.ts

import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient;

export function getTestPrisma(): PrismaClient {
  if (!prisma) {
    // globalThis is set when running in-process; process.env is set by globalSetup for worker processes
    const url =
      (globalThis as any).__TEST_DATABASE_URL__ || process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'TEST_DATABASE_URL not set. Did globalSetup run? ' +
        'This helper is only for integration/e2e tests, not unit tests.'
      );
    }
    if (!isLocalhostUrl(url)) {
      throw new Error(
        `SAFETY: DATABASE_URL is "${url}" — expected localhost. ` +
        'Refusing to connect.'
      );
    }
    prisma = new PrismaClient({ datasourceUrl: url });
  }
  return prisma;
}

export function getTestRedisUrl(): string {
  const url = (globalThis as any).__TEST_REDIS_URL__ || process.env.REDIS_URL;
  if (!url) {
    throw new Error('TEST_REDIS_URL not set. Did globalSetup run?');
  }
  if (!isLocalhostUrl(url)) {
    throw new Error(`SAFETY: REDIS_URL is "${url}" — expected localhost.`);
  }
  return url;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

// Truncate all user-created tables dynamically (avoids hardcoding table names)
export async function truncateAll(client?: PrismaClient) {
  const db = client ?? getTestPrisma();
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    AND tablename NOT LIKE '_prisma%'
  `;
  if (tables.length === 0) return;
  const tableNames = tables.map((t) => `"${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${tableNames} CASCADE`);
}
```

### E2E App Bootstrap (setup-app.ts)

E2E tests override providers explicitly, not via env:

```typescript
// test/helpers/setup-app.ts

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { getTestPrisma } from './test-db.utils';
// ... import middleware setup

export async function setupTestApp(): Promise<{ app: INestApplication; server: any }> {
  const testPrisma = getTestPrisma(); // validated localhost client

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(testPrisma)             // ← explicit, no env lookup
    .compile();

  const app = moduleFixture.createNestApplication();
  applyMiddleware(app);               // replicate main.ts stack
  await app.init();

  return { app, server: app.getHttpServer() };
}
```

### globalTeardown

```typescript
// test/helpers/test-db.teardown.ts
import nock from 'nock';

export default async function globalTeardown() {
  // Restore HTTP
  nock.cleanAll();
  nock.enableNetConnect();

  // Stop containers
  await (globalThis as any).__TEST_PG_CONTAINER__?.stop();
  await (globalThis as any).__TEST_REDIS_CONTAINER__?.stop();
}
```

### Unit Test Isolation

Unit tests (`src/**/*.spec.ts`) are isolated by a different mechanism — they never touch infrastructure at all:
- All dependencies are mocked via `jest.fn()` — no real PrismaClient, no real Redis
- `globalThis.__socketIO` is undefined → SocketService no-ops
- No `globalSetup` runs for unit tests (separate jest config)
- If a unit test accidentally imports a real service without mocking it, it fails immediately — no `DATABASE_URL` in env (only set by integration/e2e globalSetup)

### Defense Summary

```
                        ┌─────────────────────────────┐
                        │     Intended Path            │
                        │                              │
                        │  TestContainers starts PG    │
                        │  → URL passed directly to    │
                        │    PrismaClient constructor  │
                        │  → .env never consulted      │
                        │  → process.env not relied on │
                        └──────────────┬──────────────┘
                                       │
                        if that somehow fails...
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
   ┌──────────▼──────────┐  ┌─────────▼─────────┐  ┌──────────▼──────────┐
   │  Validation Gate    │  │  Localhost Guards  │  │  Network Block      │
   │                     │  │                    │  │                     │
   │  globalSetup Phase 2│  │  getTestPrisma()   │  │  nock.disable       │
   │  checks tables,     │  │  asserts URL is    │  │  NetConnect()       │
   │  emptiness, hosts,  │  │  localhost before   │  │  blocks all non-    │
   │  credentials.       │  │  returning client.  │  │  localhost HTTP.    │
   │                     │  │                    │  │                     │
   │  Fails → 0 tests   │  │  Fails → that test │  │  Fails → connection │
   │  run, full report.  │  │  fails, clear msg. │  │  error, caught.     │
   └─────────────────────┘  └────────────────────┘  └─────────────────────┘
```

### Audit Checklist (for every new external dependency)

When adding a new external service to the codebase:

1. [ ] Add its env var to the `DANGEROUS_VARS` list in `test/helpers/test-db.setup.ts`
2. [ ] If it needs a real instance in integration/e2e: add a TestContainers container in globalSetup + validation check in Phase 2
3. [ ] If it should be absent in tests: add to `MUST_BE_ABSENT` list + verify graceful no-op
4. [ ] If it makes outbound HTTP: verify `nock.disableNetConnect()` catches it
5. [ ] Add localhost guard in `test/helpers/test-db.utils.ts` for its access helper
6. [ ] Update this spec's threat model table

---

## Known Gotchas

Hard-won lessons from building the test suite. Each caused real debugging time.

### Integration tests must run serially (`maxWorkers: 1`)

`truncateAll()` issues `TRUNCATE TABLE ... CASCADE`, which acquires exclusive locks. With parallel Jest workers, two test files truncating simultaneously deadlock each other. The integration config sets `maxWorkers: 1`; the e2e script uses `--runInBand` on the CLI. Do not remove either setting.

### `forceExit: true` is required for integration and e2e configs

The `getTestRedis()` singleton in `test-db.utils.ts` creates an ioredis client with a keepalive timer that holds the Node event loop open. Even after `globalTeardown` calls `disconnectTestClients()`, the module-level singleton can remain cached by the Jest worker. Without `forceExit: true`, the test suite hangs indefinitely after all tests pass — with no error output.

### ThrottlerGuard persists rate-limit state in Redis

`ThrottlerModule` is registered globally with Redis-backed storage. Rate-limit counters (e.g., `throttle:login:127.0.0.1`) survive across test cases within a suite. Without `flushTestRedis()` in `beforeEach`, tests that hit the same endpoint repeatedly will receive unexpected 429 responses. The spec examples show `truncateAll()` in `beforeEach` for DB cleanup — Redis cleanup is equally important but easy to forget.

### Profile cache requires explicit Redis flush before count assertions

`UsersService.getPublicProfile()` has a 90-second Redis cache. Although `followUser()`/`unfollowUser()` call `invalidateProfileCache()`, e2e tests that assert on `followersCount` after mutations need an explicit `flushTestRedis()` before the read. The invalidation works on the server side but the test's read-after-write timing can hit the stale cached value. This pattern appears 5+ times in `users.e2e-spec.ts`.

### Fire-and-forget `track()` requires a delay before asserting Redis keys

`AnalyticsService.track()` uses `void Promise.all(promises)` — the `void` discards the promise, so `await track(...)` returns before Redis writes complete. Integration tests use a `waitForWrites()` helper: a 200ms `setTimeout` followed by `redis.ping()` (which forces the ioredis command queue to flush). Without this, assertions on Redis keys immediately after `track()` see `null`.

---

## File Placement

```
src/
  auth/
    auth.service.ts
    auth.service.spec.ts             ← Tier 1: unit (mocked Prisma)
    auth.guard.spec.ts               ← Tier 1: unit
test/
  helpers/
    prisma.mock.ts                   ← shared Prisma mock factory for unit tests
    redis.mock.ts                    ← shared Redis mock factory for unit tests
    socket.mock.ts                   ← shared Socket mock factory for unit tests
    auth.helpers.ts                  ← create test JWT, mock SessionUser factory
    factories.ts                     ← createTestUser(), createTestReview(), etc.
    test-db.setup.ts                 ← TestContainers globalSetup (start PG + Redis)
    test-db.teardown.ts              ← TestContainers globalTeardown (stop containers)
    test-db.utils.ts                 ← truncateAll(), getTestPrisma()
    setup-app.ts                     ← E2E app bootstrap replicating main.ts middleware
  integration/
    reviews-voting.spec.ts           ← Tier 2: real DB
    user-cascades.spec.ts            ← Tier 2: real DB
    auth-sessions.spec.ts            ← Tier 2: real DB
    complaints-voting.spec.ts        ← Tier 2: real DB
    comments-voting.spec.ts          ← Tier 2: real DB
    follows.spec.ts                  ← Tier 2: real DB
    analytics-tracking.spec.ts       ← Tier 2: real Redis
  e2e/
    auth.e2e-spec.ts                 ← Tier 3: full HTTP
    reviews.e2e-spec.ts
    complaints.e2e-spec.ts
    comments.e2e-spec.ts
    users.e2e-spec.ts
    admin.e2e-spec.ts
    search-feed-trending.e2e-spec.ts
  jest-integration.json
  jest-e2e.json
```

---

## Tier 1: Unit Tests (`src/**/*.spec.ts`)

Test a single class in isolation with all dependencies mocked. No Docker, no network, no filesystem.

**When to use:** Services, guards, pipes, filters, utility functions, Zod schemas.

**Patterns established in this codebase:**

| Pattern | When to use | Example |
|---------|-------------|---------|
| `Test.createTestingModule` + `useValue` mocks | Service with DI dependencies | `reviews.service.spec.ts` |
| Direct constructor instantiation | Simple services, no lifecycle hooks | `auth.service.spec.ts` |
| `Reflect.getMetadata` inspection | Verify decorators (guards, throttle) | `complaints.controller.spec.ts` |
| Direct function call | Pure functions, error handlers | `errors.spec.ts` |

**Shared mock factories** (in `test/helpers/`):

```typescript
// test/helpers/prisma.mock.ts
export function createPrismaMock(overrides = {}) {
  return {
    $transaction: jest.fn(async (fn) => fn(prismaMock)),
    review: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn(), create: jest.fn() },
    user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    comment: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
    complaint: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
    helpfulVote: { findUnique: jest.fn(), create: jest.fn(), delete: jest.fn(), update: jest.fn(), count: jest.fn() },
    // ... extend per model as needed
    ...overrides,
  };
}

// test/helpers/socket.mock.ts
export function createSocketMock() {
  return {
    emitReviewCreated: jest.fn(),
    emitReviewUpdated: jest.fn(),
    emitReviewVoteUpdated: jest.fn(),
    emitCommentCountUpdated: jest.fn(),
    emitNotificationCreated: jest.fn(),
    emitNotificationRead: jest.fn(),
    emitNotificationsAllRead: jest.fn(),
  };
}

// test/helpers/redis.mock.ts
export function createRedisMock(ready = false) {
  return {
    isReady: jest.fn().mockReturnValue(ready),
    getClient: jest.fn().mockReturnValue(ready ? { get: jest.fn(), set: jest.fn() } : null),
    getLastError: jest.fn(),
    setLastError: jest.fn(),
  };
}
```

**What unit tests verify:**
- Conditional branches (if vote exists → delete, else → create)
- Calculations (`calculateOverallScore`, pagination math)
- Error conditions (NotFoundError, BadRequestException, ZodError)
- Emit ordering (socket after transaction, notification after socket)
- Security invariants (no passwordHash in public responses, SHA-256 session hashing)

**What unit tests cannot verify:**
- Whether the `where` clause actually selects the right rows
- Whether `$transaction` actually provides atomicity
- Whether cascade deletes propagate correctly
- Whether the HTTP middleware stack is correctly assembled

---

## Tier 2: Integration Tests (`test/integration/*.spec.ts`)

Test service methods against a **real PostgreSQL** (and optionally real Redis) to verify that Prisma queries, transactions, and constraints work correctly. No HTTP server — call service methods directly.

**When to use:** Voting/recount integrity, cascade deletes, unique constraint enforcement, session lifecycle, complex queries (feed merge, search, trending).

**Infrastructure:** TestContainers spins up a PostgreSQL container, runs `prisma migrate deploy`, and injects the `DATABASE_URL`. Each test suite truncates all tables in `beforeEach`.

**Pattern:**

```typescript
import { PrismaService } from '../../src/prisma/prisma.service';
import { ReviewsService } from '../../src/reviews/reviews.service';
import { truncateAll, getTestPrisma } from '../helpers/test-db.utils';
import { createSocketMock } from '../helpers/socket.mock';

describe('Reviews Voting (integration)', () => {
  let prisma: PrismaService;
  let service: ReviewsService;

  beforeAll(async () => {
    prisma = getTestPrisma(); // real PrismaService pointed at TestContainers PG
    service = new ReviewsService(prisma, createSocketMock(), {} as any);
  });

  beforeEach(() => truncateAll(prisma));

  it('vote UP then vote UP again toggles off', async () => {
    // Create real user + real review in the DB
    const user = await prisma.user.create({ data: { ... } });
    const review = await prisma.review.create({ data: { ..., authorId: user.id } });
    const voter = await prisma.user.create({ data: { ... } });

    // First vote
    await service.vote(review.id, 'UP', voter.id);
    const afterFirst = await prisma.review.findUnique({ where: { id: review.id } });
    expect(afterFirst.helpfulCount).toBe(1);

    // Same vote again — toggle off
    await service.vote(review.id, 'UP', voter.id);
    const afterSecond = await prisma.review.findUnique({ where: { id: review.id } });
    expect(afterSecond.helpfulCount).toBe(0);

    // Vote record should be deleted
    const vote = await prisma.helpfulVote.findUnique({
      where: { userId_reviewId: { userId: voter.id, reviewId: review.id } },
    });
    expect(vote).toBeNull();
  });
});
```

**What integration tests verify:**
- `$transaction` recount produces correct counts in the actual database
- Unique constraints reject duplicate votes/follows (@@unique)
- Cascade deletes propagate (User → 14+ tables)
- Complex `where` clauses with filters return the right rows
- `include`/`select` return the expected shape
- Session create/lookup/delete by hashed token works end-to-end

**What integration tests cannot verify:**
- HTTP routing, guards, middleware, cookies, CSRF
- Response status codes and shapes

---

## Tier 3: E2E Tests (`test/e2e/*.e2e-spec.ts`)

Full NestJS app bootstrapped with supertest. Real PostgreSQL from the same TestContainers instance. Tests the complete HTTP lifecycle: middleware, guards, pipes, filters, cookies, response shapes.

**Pattern:**

```typescript
import * as request from 'supertest';
import { setupTestApp, teardownTestApp } from '../helpers/setup-app';
import { truncateAll, getTestPrisma } from '../helpers/test-db.utils';

describe('Auth (e2e)', () => {
  let app, server, prisma;

  beforeAll(async () => {
    ({ app, server } = await setupTestApp());
    prisma = getTestPrisma();
  });

  beforeEach(() => truncateAll(prisma));
  afterAll(() => teardownTestApp(app));

  it('register → login → me → logout → me returns null', async () => {
    // Register
    const reg = await request(server)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'test@test.com', username: 'testuser', password: 'password123' })
      .expect(201);

    const cookie = reg.headers['set-cookie'];
    expect(cookie).toBeDefined();

    // GET /me with cookie
    const me = await request(server)
      .get('/api/auth/me')
      .set('Cookie', cookie)
      .expect(200);
    expect(me.body.user.username).toBe('testuser');

    // Logout
    await request(server)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:3000')
      .expect(200);

    // GET /me after logout
    const meAfter = await request(server)
      .get('/api/auth/me')
      .expect(200);
    expect(meAfter.body.user).toBeNull();
  });
});
```

**`test/helpers/setup-app.ts`** replicates the `main.ts` middleware stack:
- Helmet
- CORS (configured for `http://localhost:3000`)
- CSRF middleware (Origin check on unsafe methods when session cookie present)
- `ValidationPipe` with same options as production
- `AllExceptionsFilter`
- cookie-parser
- Overrides `PrismaService` to use TestContainers instance

**What e2e tests verify:**
- Guards block/allow correctly (AuthGuard → 401, AdminGuard → 401)
- CSRF middleware rejects unsafe POST without valid Origin
- ValidationPipe rejects bad input (wrong types, missing fields, too long)
- Cookies are set and cleared correctly
- Rate limiting kicks in after threshold
- Response shapes match API contract
- Full request→guard→pipe→controller→service→DB→response lifecycle

---

## Reference Implementations

The full implementation code for `test/helpers/test-db.setup.ts`, `test-db.teardown.ts`, and `test-db.utils.ts` is in the **Isolation Guarantees** section above. That section is the single source of truth for the globalSetup three-phase boot sequence (Provision → Validate → Expose), the teardown, and the test access helpers.

**`test/helpers/factories.ts`** — test data factories for integration and e2e tests:

```typescript
import { PrismaClient } from '@prisma/client';
import { hashSync } from 'bcryptjs';

let counter = 0;

// Reset counter between test suites to avoid collision across parallel runs
export function resetFactoryCounter() { counter = 0; }

export async function createTestUser(prisma: PrismaClient, overrides = {}) {
  counter++;
  return prisma.user.create({
    data: {
      email: `user${counter}@test.com`,
      username: `testuser${counter}`,
      passwordHash: hashSync('password123', 1), // cost 1 for speed in tests
      ...overrides,
    },
  });
}

export async function createTestCompany(prisma: PrismaClient, overrides = {}) {
  counter++;
  return prisma.company.create({
    data: {
      name: `Test Company ${counter}`,
      slug: `test-company-${counter}`,
      category: 'EXCHANGES',
      ...overrides,
    },
  });
}

export async function createTestReview(prisma: PrismaClient, authorId: string, overrides = {}) {
  counter++;
  return prisma.review.create({
    data: {
      title: `Test Review ${counter}`,
      content: 'This is a test review with enough content to pass validation.',
      authorId,
      overallScore: 7.5,
      criteriaScores: { security: 8, easeOfUse: 7, support: 7, features: 8, value: 7 },
      status: 'APPROVED',
      ...overrides,
    },
  });
}

export async function createTestComplaint(prisma: PrismaClient, authorId: string, overrides = {}) {
  counter++;
  return prisma.complaint.create({
    data: {
      title: `Test Complaint ${counter}`,
      content: 'This is a test complaint.',
      authorId,
      ...overrides,
    },
  });
}
```

---

## Coverage Targets

```json
"coverageThreshold": {
  "global": {
    "branches": 80,
    "functions": 80,
    "lines": 85,
    "statements": 85
  }
}
```

**Exclude from coverage metrics:**
- `*.module.ts` — pure DI wiring, no logic
- `main.ts` — bootstrap entry point (tested via e2e)
- `*.dto.ts` — data shape declarations
- `api.controller.ts`, `data.service.ts` — dead code

## Priority Tiers

| Tier | Focus | Target | Test Types |
|------|-------|--------|------------|
| P0 | Security-critical (auth, guards, session, CSRF) | 95%+ | Unit + Integration + E2E |
| P1 | Data integrity (voting, transactions, recounts) | 90%+ | Unit + Integration |
| P2 | Core business logic (complex algorithms) | 85%+ | Unit + select Integration |
| P3 | CRUD operations (list, create, get) | 80%+ | Unit |
| P4 | Infrastructure (Redis, Socket, Config, Filter) | 80%+ | Unit |

## Non-Goals

- Testing `*.module.ts` files (pure NestJS wiring)
- Testing dead code (`api.controller.ts`, `data.service.ts`)
- Running TestContainers in unit tests (unit tests must be fast and Docker-free)
- Full SQL-level query testing (Prisma client-level is sufficient)
