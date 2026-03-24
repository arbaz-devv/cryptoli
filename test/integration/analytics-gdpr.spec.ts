import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import {
  getTestPrisma,
  getTestRedis,
  truncateAll,
  flushTestRedis,
} from '../helpers/test-db.utils';
import { AnalyticsService } from '../../src/analytics/analytics.service';

/**
 * Integration tests for GDPR anonymization against real PostgreSQL + Redis.
 * Verifies that anonymizeExpiredUsers() nullifies userId on rows older than
 * 90 days while preserving rows within the retention window, and that
 * anonymizeUserAnalytics() targets a specific user.
 */
describe('GDPR Anonymization (Integration)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let service: AnalyticsService;

  const makeRedisService = (client: Redis) => ({
    isReady: () => true,
    getClient: () => client,
    getLastError: () => null,
    setLastError: () => {},
  });

  beforeAll(() => {
    prisma = getTestPrisma();
    redis = getTestRedis();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis();
    service = new AnalyticsService(
      makeRedisService(redis) as any,
      undefined,
      prisma as any,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  it('should anonymize rows older than 90 days and preserve recent rows', async () => {
    const now = new Date();
    const oldDate = new Date(now);
    oldDate.setDate(oldDate.getDate() - 100); // 100 days ago
    const recentDate = new Date(now);
    recentDate.setDate(recentDate.getDate() - 30); // 30 days ago

    // Insert old event with userId
    await prisma.analyticsEvent.create({
      data: {
        eventType: 'page_view',
        userId: 'user-old',
        createdAt: oldDate,
      },
    });

    // Insert recent event with userId
    await prisma.analyticsEvent.create({
      data: {
        eventType: 'page_view',
        userId: 'user-recent',
        createdAt: recentDate,
      },
    });

    await service.anonymizeExpiredUsers();

    const events = await prisma.analyticsEvent.findMany({
      orderBy: { createdAt: 'asc' },
    });

    expect(events).toHaveLength(2);
    // Old event should be anonymized
    expect(events[0].userId).toBeNull();
    // Recent event should be preserved
    expect(events[1].userId).toBe('user-recent');
  });

  it('should anonymize all events for a specific deleted user', async () => {
    await prisma.analyticsEvent.createMany({
      data: [
        { eventType: 'page_view', userId: 'user-deleted' },
        { eventType: 'like', userId: 'user-deleted' },
        { eventType: 'page_view', userId: 'user-kept' },
      ],
    });

    const count = await service.anonymizeUserAnalytics('user-deleted');

    expect(count).toBe(2);

    const events = await prisma.analyticsEvent.findMany({
      orderBy: { createdAt: 'asc' },
    });
    const deletedUserEvents = events.filter(
      (e) => e.userId === 'user-deleted',
    );
    const keptUserEvents = events.filter((e) => e.userId === 'user-kept');

    expect(deletedUserEvents).toHaveLength(0);
    expect(keptUserEvents).toHaveLength(1);
  });

  it('should set daily guard after successful anonymization', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // Insert an old event so there's work to do
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    await prisma.analyticsEvent.create({
      data: {
        eventType: 'page_view',
        userId: 'user-x',
        createdAt: oldDate,
      },
    });

    await service.anonymizeExpiredUsers();

    // Daily guard should be set
    const ranKey = await redis.get(`analytics:anonymize:ran:${today}`);
    expect(ranKey).toBe('1');

    // Running lock should be released
    const runningKey = await redis.get('analytics:anonymize:running');
    expect(runningKey).toBeNull();
  });
});
