import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient;

export function getTestPrisma(): PrismaClient {
  if (!prisma) {
    const url = (globalThis as any).__TEST_DATABASE_URL__;
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
  const url = (globalThis as any).__TEST_REDIS_URL__;
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

// Truncate order respects FK constraints (children before parents)
const TABLES = [
  'CommentVote',
  'ComplaintVote',
  'HelpfulVote',
  'Reaction',
  'Media',
  'ComplaintReply',
  'Report',
  'PushSubscription',
  'Notification',
  'Session',
  'Comment',
  'Review',
  'Post',
  'Complaint',
  'CompanyFollow',
  'Follow',
  'Product',
  'Company',
  'User',
];

export async function truncateAll(client?: PrismaClient) {
  const db = client ?? getTestPrisma();
  for (const table of TABLES) {
    await db.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`);
  }
}
