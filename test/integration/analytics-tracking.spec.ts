import Redis from 'ioredis';
import {
  getTestRedis,
  flushTestRedis,
  getTestRedisUrl,
} from '../helpers/test-db.utils';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { RedisService } from '../../src/redis/redis.service';

/**
 * Integration tests for AnalyticsService against a real Redis container.
 * Verifies that track() writes correct Redis keys, getStats() aggregates
 * accurately, and getRealtime() reflects recent sessions. These complement
 * the unit tests (which mock Redis) by catching real Redis command errors,
 * key-naming bugs, and data-type mismatches.
 */
describe('Analytics Tracking (Integration)', () => {
  let redis: Redis;
  let analyticsService: AnalyticsService;
  let redisService: RedisService;

  beforeAll(async () => {
    redis = getTestRedis();

    // Create a real RedisService wired to the test container
    redisService = new RedisService();
    // Manually initialize with the test Redis URL
    process.env.REDIS_URL = getTestRedisUrl();
    redisService.onModuleInit();

    // Wait for Redis to be ready
    await new Promise<void>((resolve) => {
      const check = () => {
        if (redisService.isReady()) return resolve();
        setTimeout(check, 50);
      };
      check();
    });

    analyticsService = new AnalyticsService(redisService);
  });

  beforeEach(async () => {
    await flushTestRedis();
  });

  afterAll(async () => {
    await redisService.onModuleDestroy();
    // getTestRedis() singleton is closed by globalTeardown; no extra cleanup needed
  });

  /** Allow fire-and-forget Redis writes in track() to complete. */
  async function waitForWrites() {
    // track() uses void Promise.all(...) — wait for Redis pipeline to flush
    await new Promise((r) => setTimeout(r, 200));
    // Ensure writes are flushed by doing a round-trip read
    await redis.ping();
  }

  const today = new Date().toISOString().slice(0, 10);

  it('should write pageview keys to Redis after track(page_view)', async () => {
    await analyticsService.track(
      '127.0.0.1',
      'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
      {
        event: 'page_view',
        path: '/reviews',
        sessionId: 'test-session-abc',
        referrer: 'https://google.com/search?q=crypto',
      },
    );

    await waitForWrites();

    // Verify core keys exist with correct values
    const pageviews = await redis.get(`analytics:pageviews:${today}`);
    expect(Number(pageviews)).toBeGreaterThanOrEqual(1);

    const country = await redis.hgetall(`analytics:country:${today}`);
    // 127.0.0.1 is private → resolves to 'unknown'
    expect(country).toHaveProperty('unknown');

    const device = await redis.hgetall(`analytics:device:${today}`);
    expect(device).toHaveProperty('desktop');

    const browser = await redis.hgetall(`analytics:browser:${today}`);
    expect(browser).toHaveProperty('chrome');

    const path = await redis.hgetall(`analytics:path:${today}`);
    expect(path).toHaveProperty('/reviews');

    const referrer = await redis.hgetall(`analytics:referrer:${today}`);
    expect(referrer['google.com']).toBe('1');
  });

  it('should return aggregated stats matching tracked data', async () => {
    // Track 3 page views from different sessions
    for (let i = 0; i < 3; i++) {
      await analyticsService.track('127.0.0.1', 'Mozilla/5.0 Chrome/120', {
        event: 'page_view',
        path: '/home',
        sessionId: `session-${i}`,
      });
    }

    await waitForWrites();

    const stats = await analyticsService.getStats(today, today);
    expect(stats).not.toBeNull();
    expect(stats!.totalPageviews).toBe(3);
    expect(stats!.timeSeries).toHaveLength(1);
    expect(stats!.timeSeries[0].date).toBe(today);
    expect(stats!.timeSeries[0].pageviews).toBe(3);
    expect(stats!.dateRange.from).toBe(today);
    expect(stats!.dateRange.to).toBe(today);
    expect(stats!.topPages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/home', pageviews: 3 }),
      ]),
    );
  });

  it('should reflect active sessions in getRealtime()', async () => {
    await analyticsService.track('127.0.0.1', 'Mozilla/5.0 Chrome/120', {
      event: 'page_view',
      path: '/dashboard',
      sessionId: 'realtime-session-1',
    });

    await analyticsService.track('127.0.0.1', 'Mozilla/5.0 Firefox/115', {
      event: 'page_view',
      path: '/settings',
      sessionId: 'realtime-session-2',
    });

    await waitForWrites();

    const realtime = await analyticsService.getRealtime();
    expect(realtime.activeNow).toBe(2);
    // Both sessions are from private IPs → country 'unknown'
    expect(realtime.byCountry).toHaveProperty('unknown');
  });

  it('should gracefully no-op when Redis is not ready', async () => {
    // Create an AnalyticsService with a disconnected RedisService
    const disconnectedRedis = new RedisService();
    // Don't call onModuleInit → isReady() returns false
    const isolatedService = new AnalyticsService(disconnectedRedis);

    // track() should silently return without throwing
    await expect(
      isolatedService.track('1.2.3.4', 'Chrome', {
        event: 'page_view',
        path: '/',
        sessionId: 'noop-session',
      }),
    ).resolves.toBeUndefined();

    // getStats() should return emptyStats
    const stats = await isolatedService.getStats(today, today);
    expect(stats).not.toBeNull();
    expect(stats!.totalPageviews).toBe(0);
    expect(stats!.timeSeries).toEqual([]);

    // getRealtime() should return zeros
    const realtime = await isolatedService.getRealtime();
    expect(realtime.activeNow).toBe(0);
    expect(realtime.byCountry).toEqual({});
  });

  it('should track like events in Redis', async () => {
    await analyticsService.track('127.0.0.1', 'Chrome', { event: 'like' });

    await waitForWrites();

    const likes = await redis.get(`analytics:like:${today}`);
    expect(Number(likes)).toBe(1);
  });

  it('should not store data when consent is false', async () => {
    await analyticsService.track('127.0.0.1', 'Chrome', {
      event: 'page_view',
      path: '/private',
      sessionId: 'no-consent-session',
      consent: false,
    });

    await waitForWrites();

    const pageviews = await redis.get(`analytics:pageviews:${today}`);
    expect(pageviews).toBeNull();
  });
});
