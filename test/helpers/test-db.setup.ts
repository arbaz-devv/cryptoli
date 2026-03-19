import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { hashSync } from 'bcryptjs';
import Redis from 'ioredis';
import nock from 'nock';

export default async function globalSetup() {
  // ── Phase 1: Provision ──────────────────────────────────────────
  const pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('cryptoli_test')
    .start();

  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const databaseUrl = pg.getConnectionUri();
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const testPrisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const testRedisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  // ── Phase 2: Validate ──────────────────────────────────────────
  const errors: string[] = [];

  // 2a. Database is reachable and migrated
  try {
    const tables = await testPrisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    const names = tables.map((t) => t.tablename);
    for (const required of [
      'User',
      'Review',
      'Session',
      'Comment',
      'Complaint',
      'Company',
      'HelpfulVote',
      'Notification',
      'Follow',
    ]) {
      if (!names.includes(required)) {
        errors.push(
          `Missing table "${required}" — prisma migrate deploy may have failed`,
        );
      }
    }
  } catch (e: any) {
    errors.push(`Cannot connect to test PostgreSQL: ${e.message}`);
  }

  // 2b. Database is empty
  try {
    const count = await testPrisma.user.count();
    if (count > 0) {
      errors.push(
        `Test database has ${count} users — expected empty. Stale container?`,
      );
    }
  } catch (e: any) {
    errors.push(`Cannot query test database: ${e.message}`);
  }

  // 2c. Redis is reachable
  try {
    const testRedisClient = new Redis(testRedisUrl);
    const pong = await testRedisClient.ping();
    if (pong !== 'PONG')
      errors.push(`Redis ping returned "${pong}" — expected PONG`);
    await testRedisClient.quit();
  } catch (e: any) {
    errors.push(`Cannot connect to test Redis: ${e.message}`);
  }

  // 2d. Connections are localhost
  if (!isLocalhost(pg.getHost())) {
    errors.push(`PostgreSQL host is "${pg.getHost()}" — expected localhost`);
  }
  if (!isLocalhost(redis.getHost())) {
    errors.push(`Redis host is "${redis.getHost()}" — expected localhost`);
  }

  // 2e. Dangerous credentials are NOT in environment
  const MUST_BE_ABSENT = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
  for (const v of MUST_BE_ABSENT) {
    if (process.env[v]) {
      errors.push(
        `${v} is set — push notifications could fire against real endpoints`,
      );
    }
  }

  // 2f. GATE
  if (errors.length > 0) {
    await testPrisma.$disconnect();
    await pg.stop();
    await redis.stop();
    throw new Error(
      '\n╔══════════════════════════════════════════════════════╗\n' +
        '║  TEST INFRASTRUCTURE VALIDATION FAILED              ║\n' +
        '╠══════════════════════════════════════════════════════╣\n' +
        errors.map((e, i) => `║  ${i + 1}. ${e}`).join('\n') +
        '\n' +
        '╠══════════════════════════════════════════════════════╣\n' +
        '║  No tests will run. Fix the above issues first.     ║\n' +
        '╚══════════════════════════════════════════════════════╝',
    );
  }

  // ── Phase 3: Expose ────────────────────────────────────────────
  await testPrisma.$disconnect();

  (globalThis as any).__TEST_PG_CONTAINER__ = pg;
  (globalThis as any).__TEST_REDIS_CONTAINER__ = redis;
  (globalThis as any).__TEST_DATABASE_URL__ = databaseUrl;
  (globalThis as any).__TEST_REDIS_URL__ = testRedisUrl;

  // Clear dangerous vars, then set container URLs
  const DANGEROUS_VARS = [
    'DATABASE_URL',
    'REDIS_URL',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
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

  // Block outbound HTTP — last line of defense
  nock.disableNetConnect();
  nock.enableNetConnect((host) =>
    /^(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(host),
  );
}

function isLocalhost(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}
