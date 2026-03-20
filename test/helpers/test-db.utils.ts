import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

let prisma: PrismaClient;

export function getTestPrisma(): PrismaClient {
  if (!prisma) {
    // globalThis is set when running in-process; process.env is set by globalSetup for worker processes
    const url =
      (globalThis as any).__TEST_DATABASE_URL__ || process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'TEST_DATABASE_URL not set. Did globalSetup run? ' +
          'This helper is only for integration/e2e tests, not unit tests.',
      );
    }
    if (!isLocalhostUrl(url)) {
      throw new Error(
        `SAFETY: DATABASE_URL is "${url}" — expected localhost. Refusing to connect.`,
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
    throw new Error(
      `SAFETY: REDIS_URL is "${url}" — expected localhost. Refusing to connect.`,
    );
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

let redisClient: Redis | null = null;

export function getTestRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(getTestRedisUrl());
  }
  return redisClient;
}

export async function flushTestRedis() {
  const redis = getTestRedis();
  await redis.flushall();
}

export async function disconnectTestClients() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined as any;
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
