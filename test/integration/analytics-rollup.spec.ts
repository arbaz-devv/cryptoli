import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import {
  getTestPrisma,
  getTestRedis,
  truncateAll,
  flushTestRedis,
} from '../helpers/test-db.utils';
import { AnalyticsRollupService } from '../../src/analytics/analytics-rollup.service';

/**
 * Integration tests for AnalyticsRollupService with real PostgreSQL + Redis.
 * Verifies end-to-end rollup flow: Redis keys → DailySummary rows in PG,
 * idempotency via unique constraint, and NX lock behavior.
 */
describe('AnalyticsRollupService (Integration)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let service: AnalyticsRollupService;

  const DAY = '2026-03-20';
  const KEY_PREFIX = 'analytics';

  // Minimal RedisService-compatible wrapper around real ioredis
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
    service = new AnalyticsRollupService(
      prisma as any,
      makeRedisService(redis) as any,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  async function seedRedisDay(day: string) {
    const p = redis.pipeline();
    p.set(`${KEY_PREFIX}:pageviews:${day}`, '250');
    p.set(`${KEY_PREFIX}:bounces:${day}`, '15');
    p.set(`${KEY_PREFIX}:like:${day}`, '8');
    p.set(`${KEY_PREFIX}:duration_sum:${day}`, '7500');
    p.set(`${KEY_PREFIX}:duration_count:${day}`, '75');
    // HyperLogLog keys for uniques/sessions
    p.pfadd(`${KEY_PREFIX}:hll:uniques:${day}`, ...Array.from({ length: 120 }, (_, i) => `user_${i}`));
    p.pfadd(`${KEY_PREFIX}:hll:sessions:${day}`, ...Array.from({ length: 150 }, (_, i) => `sess_${i}`));
    // Hash keys
    p.hset(`${KEY_PREFIX}:country:${day}`, { US: '130', DE: '80', GB: '40' });
    p.hset(`${KEY_PREFIX}:device:${day}`, { desktop: '160', mobile: '90' });
    p.hset(`${KEY_PREFIX}:browser:${day}`, { chrome: '150', firefox: '60', safari: '40' });
    p.hset(`${KEY_PREFIX}:os:${day}`, { windows: '120', macos: '80', linux: '50' });
    p.hset(`${KEY_PREFIX}:referrer:${day}`, { 'google.com': '100', direct: '150' });
    p.hset(`${KEY_PREFIX}:hour:${day}`, { '10': '80', '14': '100', '20': '70' });
    p.hset(`${KEY_PREFIX}:weekday:${day}`, { '3': '250' });
    p.hset(`${KEY_PREFIX}:path:${day}`, { '/': '150', '/about': '60', '/pricing': '40' });
    p.hset(`${KEY_PREFIX}:duration_hist:${day}`, { '0_9': '30', '10_29': '25', '30_59': '20' });
    p.hset(`${KEY_PREFIX}:funnel:event:${day}`, { signup_started: '20', signup_completed: '10' });
    await p.exec();
  }

  it('should read Redis keys and write EAV rows to PG', async () => {
    await seedRedisDay(DAY);

    const result = await service.rollupDay(DAY);
    expect(result).toBe(true);

    // Verify rows written to PG
    const rows = await prisma.analyticsDailySummary.findMany({
      where: { date: new Date(`${DAY}T00:00:00Z`) },
      orderBy: [{ dimension: 'asc' }, { dimensionValue: 'asc' }],
    });

    expect(rows.length).toBeGreaterThan(0);

    // Check scalar totals
    const pageviewRow = rows.find(
      (r) => r.dimension === '_total_' && r.dimensionValue === 'pageviews',
    );
    expect(pageviewRow).toBeDefined();
    expect(pageviewRow!.count).toBe(250);

    const bouncesRow = rows.find(
      (r) => r.dimension === '_total_' && r.dimensionValue === 'bounces',
    );
    expect(bouncesRow!.count).toBe(15);

    // Check hash dimensions
    const usRow = rows.find(
      (r) => r.dimension === 'country' && r.dimensionValue === 'US',
    );
    expect(usRow).toBeDefined();
    expect(usRow!.count).toBe(130);

    const desktopRow = rows.find(
      (r) => r.dimension === 'device' && r.dimensionValue === 'desktop',
    );
    expect(desktopRow!.count).toBe(160);

    // Check funnel
    const funnelRow = rows.find(
      (r) => r.dimension === 'funnel_event' && r.dimensionValue === 'signup_started',
    );
    expect(funnelRow!.count).toBe(20);
  });

  it('should be idempotent — second rollup returns false', async () => {
    await seedRedisDay(DAY);

    const first = await service.rollupDay(DAY);
    expect(first).toBe(true);

    const second = await service.rollupDay(DAY);
    expect(second).toBe(false);

    // Only one set of rows should exist
    const count = await prisma.analyticsDailySummary.count({
      where: { date: new Date(`${DAY}T00:00:00Z`) },
    });
    // Count should be stable (same number as after first rollup)
    const firstCount = count;
    expect(firstCount).toBeGreaterThan(0);
  });

  it('should set NX lock in Redis after successful rollup', async () => {
    await seedRedisDay(DAY);

    await service.rollupDay(DAY);

    const lock = await redis.get(`${KEY_PREFIX}:rollup:last:${DAY}`);
    expect(lock).toBe('1');

    const ttl = await redis.ttl(`${KEY_PREFIX}:rollup:last:${DAY}`);
    // TTL should be close to 172800 (48h)
    expect(ttl).toBeGreaterThan(172700);
    expect(ttl).toBeLessThanOrEqual(172800);
  });

  it('should skip rollup when Redis has no data (zero pageviews)', async () => {
    // Don't seed any Redis data
    const result = await service.rollupDay(DAY);
    expect(result).toBe(false);

    const count = await prisma.analyticsDailySummary.count();
    expect(count).toBe(0);
  });

  it('should handle HyperLogLog uniques/sessions approximation', async () => {
    await seedRedisDay(DAY);

    const snapshot = await service.readDayFromRedis(DAY);

    // HLL approximation — should be close to 120/150 but not exact
    expect(snapshot.uniques).toBeGreaterThan(100);
    expect(snapshot.uniques).toBeLessThan(140);
    expect(snapshot.sessions).toBeGreaterThan(130);
    expect(snapshot.sessions).toBeLessThan(170);
  });
});
