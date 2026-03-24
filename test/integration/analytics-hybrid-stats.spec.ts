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
 * Integration tests for hybrid getStats() with real PG + Redis.
 * Verifies the day-partitioning logic that reads old days from
 * AnalyticsDailySummary (PG) and recent days from Redis, then
 * merges them into a single response.
 *
 * Invariant: getStats() must produce correct aggregates regardless
 * of whether data comes from PG, Redis, or both. TimeSeries must
 * be ordered chronologically with PG entries before Redis entries.
 */
describe('AnalyticsService hybrid getStats() (Integration)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let service: AnalyticsService;

  const KEY_PREFIX = 'analytics';

  // Minimal RedisService-compatible wrapper around real ioredis
  const makeRedisService = (client: Redis) => ({
    isReady: () => true,
    getClient: () => client,
    getLastError: () => null,
    setLastError: () => {},
  });

  // A day guaranteed to be >28 days ago (PG territory)
  const pgDay = '2025-12-01';
  // Today's date string (Redis territory — always within 28 days)
  const today = new Date().toISOString().slice(0, 10);
  // Yesterday (also Redis territory)
  const yesterday = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  beforeAll(() => {
    prisma = getTestPrisma();
    redis = getTestRedis();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis();
    service = new AnalyticsService(
      makeRedisService(redis) as any,
      undefined, // bufferService (optional)
      prisma as any, // prismaService (optional)
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  /**
   * Seed PG with AnalyticsDailySummary EAV rows for a given day.
   * Mimics what AnalyticsRollupService.rollupDay() produces.
   */
  async function seedPgDay(
    day: string,
    data: {
      pageviews: number;
      bounces: number;
      likes: number;
      durationSum: number;
      durationCount: number;
      uniquesApprox: number;
      sessionsApprox: number;
      country?: Record<string, number>;
      device?: Record<string, number>;
      browser?: Record<string, number>;
      path?: Record<string, number>;
      durationHist?: Record<string, number>;
      funnelEvent?: Record<string, number>;
      hour?: Record<string, number>;
      weekday?: Record<string, number>;
    },
  ) {
    const date = new Date(`${day}T00:00:00Z`);
    const rows: Array<{
      date: Date;
      dimension: string;
      dimensionValue: string;
      count: number;
    }> = [];

    // Scalar _total_ rows
    rows.push({ date, dimension: '_total_', dimensionValue: 'pageviews', count: data.pageviews });
    rows.push({ date, dimension: '_total_', dimensionValue: 'bounces', count: data.bounces });
    rows.push({ date, dimension: '_total_', dimensionValue: 'likes', count: data.likes });
    rows.push({ date, dimension: '_total_', dimensionValue: 'duration_sum', count: data.durationSum });
    rows.push({ date, dimension: '_total_', dimensionValue: 'duration_count', count: data.durationCount });
    rows.push({ date, dimension: '_total_', dimensionValue: 'uniques_approx', count: data.uniquesApprox });
    rows.push({ date, dimension: '_total_', dimensionValue: 'sessions_approx', count: data.sessionsApprox });

    // Hash dimension rows
    const hashDimensions: Array<[string, Record<string, number> | undefined]> = [
      ['country', data.country],
      ['device', data.device],
      ['browser', data.browser],
      ['path', data.path],
      ['duration_bucket', data.durationHist],
      ['funnel_event', data.funnelEvent],
      ['hour', data.hour],
      ['weekday', data.weekday],
    ];
    for (const [dimension, values] of hashDimensions) {
      if (!values) continue;
      for (const [dimensionValue, count] of Object.entries(values)) {
        rows.push({ date, dimension, dimensionValue, count });
      }
    }

    await prisma.analyticsDailySummary.createMany({ data: rows });
  }

  /**
   * Seed Redis with analytics keys for a given day (same pattern as rollup integration tests).
   */
  async function seedRedisDay(
    day: string,
    data: {
      pageviews: number;
      bounces: number;
      likes: number;
      durationSum: number;
      durationCount: number;
      uniqueMembers?: string[];
      sessionMembers?: string[];
      country?: Record<string, string>;
      device?: Record<string, string>;
      browser?: Record<string, string>;
      path?: Record<string, string>;
      durationHist?: Record<string, string>;
      funnelEvent?: Record<string, string>;
      hour?: Record<string, string>;
      weekday?: Record<string, string>;
    },
  ) {
    const p = redis.pipeline();
    p.set(`${KEY_PREFIX}:pageviews:${day}`, String(data.pageviews));
    p.set(`${KEY_PREFIX}:bounces:${day}`, String(data.bounces));
    p.set(`${KEY_PREFIX}:like:${day}`, String(data.likes));
    p.set(`${KEY_PREFIX}:duration_sum:${day}`, String(data.durationSum));
    p.set(`${KEY_PREFIX}:duration_count:${day}`, String(data.durationCount));

    if (data.uniqueMembers && data.uniqueMembers.length > 0) {
      p.pfadd(`${KEY_PREFIX}:hll:uniques:${day}`, ...data.uniqueMembers);
    }
    if (data.sessionMembers && data.sessionMembers.length > 0) {
      p.pfadd(`${KEY_PREFIX}:hll:sessions:${day}`, ...data.sessionMembers);
    }
    if (data.country) p.hset(`${KEY_PREFIX}:country:${day}`, data.country);
    if (data.device) p.hset(`${KEY_PREFIX}:device:${day}`, data.device);
    if (data.browser) p.hset(`${KEY_PREFIX}:browser:${day}`, data.browser);
    if (data.path) p.hset(`${KEY_PREFIX}:path:${day}`, data.path);
    if (data.durationHist) p.hset(`${KEY_PREFIX}:duration_hist:${day}`, data.durationHist);
    if (data.funnelEvent) p.hset(`${KEY_PREFIX}:funnel:event:${day}`, data.funnelEvent);
    if (data.hour) p.hset(`${KEY_PREFIX}:hour:${day}`, data.hour);
    if (data.weekday) p.hset(`${KEY_PREFIX}:weekday:${day}`, data.weekday);

    await p.exec();
  }

  it('should read PG-only data when entire range is older than 28 days', async () => {
    const pgDay2 = '2025-12-02';
    await seedPgDay(pgDay, {
      pageviews: 200,
      bounces: 10,
      likes: 5,
      durationSum: 6000,
      durationCount: 60,
      uniquesApprox: 80,
      sessionsApprox: 90,
      country: { US: 120, DE: 80 },
      device: { desktop: 130, mobile: 70 },
      path: { '/': 100, '/about': 50, '/pricing': 50 },
    });
    await seedPgDay(pgDay2, {
      pageviews: 100,
      bounces: 5,
      likes: 3,
      durationSum: 3000,
      durationCount: 30,
      uniquesApprox: 40,
      sessionsApprox: 50,
      country: { US: 60, GB: 40 },
      device: { desktop: 70, mobile: 30 },
    });

    const result = await service.getStats(pgDay, pgDay2);

    expect(result).not.toBeNull();
    // Additive scalar merge across 2 PG days
    expect(result!.totalPageviews).toBe(300);
    expect(result!.totalBounces).toBe(15);
    expect(result!.likes).toBe(8);
    // PG uniques/sessions are summed per-day snapshots
    expect(result!.totalUniques).toBe(120);
    expect(result!.totalSessions).toBe(140);
    // Country merge: US = 120 + 60 = 180
    expect(result!.byCountry.US).toBe(180);
    expect(result!.byCountry.DE).toBe(80);
    expect(result!.byCountry.GB).toBe(40);
    // TimeSeries has both days in order
    expect(result!.timeSeries).toHaveLength(2);
    expect(result!.timeSeries[0].date).toBe(pgDay);
    expect(result!.timeSeries[0].pageviews).toBe(200);
    expect(result!.timeSeries[1].date).toBe(pgDay2);
    expect(result!.timeSeries[1].pageviews).toBe(100);
    // Derived: avgDuration = 9000 / 90 = 100
    expect(result!.avgDurationSeconds).toBe(100);
    // Derived: bounceRate = (15 / 140) * 100
    expect(result!.bounceRate).toBeCloseTo((15 / 140) * 100, 1);
  });

  it('should read Redis-only data when entire range is recent', async () => {
    await seedRedisDay(yesterday, {
      pageviews: 150,
      bounces: 8,
      likes: 4,
      durationSum: 4500,
      durationCount: 45,
      uniqueMembers: Array.from({ length: 60 }, (_, i) => `u_${i}`),
      sessionMembers: Array.from({ length: 80 }, (_, i) => `s_${i}`),
      country: { US: '90', DE: '60' },
      device: { desktop: '100', mobile: '50' },
      path: { '/': '80', '/about': '70' },
    });

    const result = await service.getStats(yesterday, yesterday);

    expect(result).not.toBeNull();
    expect(result!.totalPageviews).toBe(150);
    expect(result!.totalBounces).toBe(8);
    expect(result!.likes).toBe(4);
    // HLL uniques are approximate but should be close to 60
    expect(result!.totalUniques).toBeGreaterThan(50);
    expect(result!.totalUniques).toBeLessThan(70);
    expect(result!.byCountry.US).toBe(90);
    expect(result!.timeSeries).toHaveLength(1);
    expect(result!.timeSeries[0].date).toBe(yesterday);
  });

  it('should merge PG + Redis data in hybrid range', async () => {
    // Seed PG with old data (>28 days ago)
    await seedPgDay(pgDay, {
      pageviews: 200,
      bounces: 10,
      likes: 5,
      durationSum: 6000,
      durationCount: 60,
      uniquesApprox: 80,
      sessionsApprox: 90,
      country: { US: 120, DE: 80 },
      device: { desktop: 130, mobile: 70 },
      browser: { chrome: 120, firefox: 80 },
      path: { '/': 100, '/about': 50, '/pricing': 50 },
      durationHist: { '0_9': 20, '10_29': 25, '30_59': 15 },
      funnelEvent: { signup_started: 15, signup_completed: 8, purchase: 3 },
      hour: { '10': 60, '14': 80, '20': 60 },
      weekday: { '1': 200 },
    });

    // Seed Redis with recent data (within 28 days)
    await seedRedisDay(yesterday, {
      pageviews: 150,
      bounces: 8,
      likes: 4,
      durationSum: 4500,
      durationCount: 45,
      uniqueMembers: Array.from({ length: 60 }, (_, i) => `u_${i}`),
      sessionMembers: Array.from({ length: 80 }, (_, i) => `s_${i}`),
      country: { US: '90', DE: '60' },
      device: { desktop: '100', mobile: '50' },
      browser: { chrome: '100', safari: '50' },
      path: { '/': '80', '/about': '40', '/blog': '30' },
      durationHist: { '0_9': '15', '10_29': '20', '60_119': '10' },
      funnelEvent: { signup_started: '10', signup_completed: '6', purchase: '2' },
      hour: { '10': '40', '14': '60', '22': '50' },
      weekday: { '3': '150' },
    });

    const result = await service.getStats(pgDay, yesterday);

    expect(result).not.toBeNull();

    // Scalar merge: PG + Redis
    expect(result!.totalPageviews).toBe(350); // 200 + 150
    expect(result!.totalBounces).toBe(18); // 10 + 8
    expect(result!.likes).toBe(9); // 5 + 4

    // Uniques: PG sum (80) + Redis HLL (~60)
    expect(result!.totalUniques).toBeGreaterThan(130);
    expect(result!.totalUniques).toBeLessThan(150);

    // Sessions: PG sum (90) + Redis HLL (~80)
    expect(result!.totalSessions).toBeGreaterThan(160);
    expect(result!.totalSessions).toBeLessThan(180);

    // Country merge: US = 120 + 90 = 210, DE = 80 + 60 = 140
    expect(result!.byCountry.US).toBe(210);
    expect(result!.byCountry.DE).toBe(140);

    // Device merge: desktop = 130 + 100 = 230, mobile = 70 + 50 = 120
    expect(result!.byDevice.desktop).toBe(230);
    expect(result!.byDevice.mobile).toBe(120);

    // Browser merge: chrome = 120 + 100 = 220, firefox = 80 (PG only), safari = 50 (Redis only)
    expect(result!.byBrowser.chrome).toBe(220);
    expect(result!.byBrowser.firefox).toBe(80);
    expect(result!.byBrowser.safari).toBe(50);

    // Path merge: '/' = 100 + 80 = 180, '/about' = 50 + 40 = 90, '/blog' = 30 (Redis only)
    const topPagesMap = Object.fromEntries(
      result!.topPages.map((p) => [p.path, p.pageviews]),
    );
    expect(topPagesMap['/']).toBe(180);
    expect(topPagesMap['/about']).toBe(90);
    expect(topPagesMap['/blog']).toBe(30);

    // Duration histogram merge: 0_9 = 20 + 15 = 35, 10_29 = 25 + 20 = 45
    // Derived: avgDuration = (6000 + 4500) / (60 + 45) = 100
    expect(result!.avgDurationSeconds).toBe(100);

    // Duration percentiles are recomputed from merged histogram
    // Total histogram count = 35 + 45 + 15 + 10 = 105
    // P50 = 50th percentile of the merged histogram
    expect(result!.durationP50Seconds).toBeGreaterThan(0);

    // Funnel merge: signup_started = 15 + 10 = 25, signup_completed = 8 + 6 = 14
    expect(result!.funnel.signup_started).toBe(25);
    expect(result!.funnel.signup_completed).toBe(14);
    expect(result!.funnel.purchase).toBe(5);
    // Derived funnel rates computed post-merge
    expect(result!.funnel.signupCompletionRate).toBeCloseTo((14 / 25) * 100, 1);
    expect(result!.funnel.purchaseRate).toBeCloseTo((5 / 25) * 100, 1);

    // Hour merge: 10 = 60 + 40 = 100, 14 = 80 + 60 = 140
    expect(result!.byHour['10']).toBe(100);
    expect(result!.byHour['14']).toBe(140);
    expect(result!.byHour['22']).toBe(50); // Redis only

    // Weekday merge: Mon (1) = 200, Wed (3) = 150
    expect(result!.byWeekday.Mon).toBe(200);
    expect(result!.byWeekday.Wed).toBe(150);
  });

  it('should order timeSeries with PG days before Redis days', async () => {
    // Use unique dates to avoid statsCache collisions with other tests
    const oldDay1 = '2025-11-01';
    const oldDay2 = '2025-11-02';
    await seedPgDay(oldDay1, {
      pageviews: 100,
      bounces: 5,
      likes: 2,
      durationSum: 3000,
      durationCount: 30,
      uniquesApprox: 40,
      sessionsApprox: 50,
      country: { US: 100 },
    });
    await seedPgDay(oldDay2, {
      pageviews: 120,
      bounces: 6,
      likes: 3,
      durationSum: 3600,
      durationCount: 36,
      uniquesApprox: 45,
      sessionsApprox: 55,
    });

    await seedRedisDay(yesterday, {
      pageviews: 80,
      bounces: 4,
      likes: 1,
      durationSum: 2400,
      durationCount: 24,
      uniqueMembers: ['u_1', 'u_2', 'u_3'],
      sessionMembers: ['s_1', 's_2', 's_3'],
    });

    const result = await service.getStats(oldDay1, yesterday);
    expect(result).not.toBeNull();

    // TimeSeries must start with PG days in date order, then Redis days
    const dates = result!.timeSeries.map((t) => t.date);
    expect(dates[0]).toBe(oldDay1);
    expect(dates[1]).toBe(oldDay2);
    // Last element should be yesterday (Redis territory)
    expect(dates[dates.length - 1]).toBe(yesterday);

    // PG day pageviews are exact
    expect(result!.timeSeries[0].pageviews).toBe(100);
    expect(result!.timeSeries[0].uniques).toBe(40);
    expect(result!.timeSeries[1].pageviews).toBe(120);
    expect(result!.timeSeries[1].uniques).toBe(45);

    // Redis day pageviews
    const lastEntry = result!.timeSeries[result!.timeSeries.length - 1];
    expect(lastEntry.pageviews).toBe(80);
  });

  it('should handle PG days with no data (zero-fill in timeSeries)', async () => {
    // Seed only one PG day, but request a 2-day range that includes an empty day
    const seedDay = '2025-10-01';
    const emptyDay = '2025-10-03';
    await seedPgDay(seedDay, {
      pageviews: 50,
      bounces: 2,
      likes: 1,
      durationSum: 1500,
      durationCount: 15,
      uniquesApprox: 20,
      sessionsApprox: 25,
    });

    // Request range seedDay to emptyDay (no data for emptyDay)
    const result = await service.getStats(seedDay, emptyDay);
    expect(result).not.toBeNull();

    // Find the empty day in timeSeries — should be zero-filled
    const emptyEntry = result!.timeSeries.find((t) => t.date === emptyDay);
    expect(emptyEntry).toBeDefined();
    expect(emptyEntry!.pageviews).toBe(0);
    expect(emptyEntry!.uniques).toBe(0);

    // The seeded day should have data
    const seededEntry = result!.timeSeries.find((t) => t.date === seedDay);
    expect(seededEntry).toBeDefined();
    expect(seededEntry!.pageviews).toBe(50);
  });

  it('should compute bounceRate from merged components, not average of rates', async () => {
    // Use a date exactly 30 days ago — just barely in PG territory (cutoff is 28 days)
    const thirtyDaysAgo = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 30);
      return d.toISOString().slice(0, 10);
    })();
    // PG: 20 bounces / 100 sessions = 20% bounce rate
    await seedPgDay(thirtyDaysAgo, {
      pageviews: 500,
      bounces: 20,
      likes: 0,
      durationSum: 0,
      durationCount: 0,
      uniquesApprox: 0,
      sessionsApprox: 100,
    });

    // Redis: 80 bounces / ~100 sessions = 80% bounce rate
    await seedRedisDay(yesterday, {
      pageviews: 300,
      bounces: 80,
      likes: 0,
      durationSum: 0,
      durationCount: 0,
      sessionMembers: Array.from({ length: 100 }, (_, i) => `s_${i}`),
    });

    const result = await service.getStats(thirtyDaysAgo, yesterday);
    expect(result).not.toBeNull();

    // Combined bounceRate derived from merged totals, not averaged per-window
    expect(result!.totalBounces).toBe(100); // 20 + 80
    expect(result!.bounceRate).toBeCloseTo(
      (100 / result!.totalSessions) * 100,
      0.1,
    );
  });

  it('should merge duration histogram and recompute percentiles correctly', async () => {
    // Use a date exactly 29 days ago — just in PG territory
    const twentyNineDaysAgo = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 29);
      return d.toISOString().slice(0, 10);
    })();
    // PG: 50 sessions in 0-9s bucket, 50 in 10-29s bucket
    await seedPgDay(twentyNineDaysAgo, {
      pageviews: 100,
      bounces: 0,
      likes: 0,
      durationSum: 2000,
      durationCount: 100,
      uniquesApprox: 0,
      sessionsApprox: 100,
      durationHist: { '0_9': 50, '10_29': 50 },
    });

    // Redis: 50 sessions in 60-119s bucket
    await seedRedisDay(yesterday, {
      pageviews: 50,
      bounces: 0,
      likes: 0,
      durationSum: 5000,
      durationCount: 50,
      durationHist: { '60_119': '50' },
    });

    const result = await service.getStats(twentyNineDaysAgo, yesterday);
    expect(result).not.toBeNull();

    // Merged histogram: 0_9=50, 10_29=50, 60_119=50 (total 150 sessions)
    // P50 (75th session): first 50 in 0_9, next 50 in 10_29 → P50 is in 10_29 bucket (max=29)
    expect(result!.durationP50Seconds).toBe(29);

    // P95 (143rd session out of 150): in the 60_119 bucket (max=119)
    expect(result!.durationP95Seconds).toBe(119);

    // avgDuration = (2000 + 5000) / (100 + 50) = 46.67
    expect(result!.avgDurationSeconds).toBeCloseTo(46.67, 1);
  });
});
