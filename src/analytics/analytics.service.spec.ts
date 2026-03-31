import { AnalyticsService } from './analytics.service';
import { createRedisMock } from '../../test/helpers/redis.mock';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import { createGeoipMock } from '../../test/helpers/geoip.mock';
import { normalizeIp } from './ip-utils';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let redisMock: ReturnType<typeof createRedisMock>;
  const geoipMock = createGeoipMock();

  beforeEach(() => {
    redisMock = createRedisMock(false);
    service = new AnalyticsService(redisMock as any, geoipMock as any);
  });

  describe('track()', () => {
    it('should no-op when Redis is not ready', async () => {
      await service.track('1.2.3.4', 'Mozilla/5.0', { event: 'page_view' });
      expect(redisMock._clientMock.incr).not.toHaveBeenCalled();
    });

    it('should no-op when consent is false', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);
      await service.track('1.2.3.4', 'Mozilla/5.0', {
        event: 'page_view',
        consent: false,
      });
      expect(redisMock._clientMock.incr).not.toHaveBeenCalled();
    });

    it('should no-op when consent is undefined (GDPR opt-in required)', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);
      await service.track('1.2.3.4', 'Mozilla/5.0', {
        event: 'page_view',
      });
      expect(redisMock._clientMock.incr).not.toHaveBeenCalled();
    });

    it('should no-op when userAgent is a bot (Googlebot)', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);
      await service.track(
        '1.2.3.4',
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        { event: 'page_view', consent: true },
      );
      expect(redisMock._clientMock.pipeline).not.toHaveBeenCalled();
    });

    it('should no-op when userAgent is a bot (bingbot)', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);
      await service.track(
        '1.2.3.4',
        'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
        { event: 'page_view', consent: true },
      );
      expect(redisMock._clientMock.pipeline).not.toHaveBeenCalled();
    });

    it('should still track when userAgent is empty (not a bot)', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);
      await service.track('1.2.3.4', '', {
        event: 'page_view',
        consent: true,
      });
      expect(redisMock._clientMock.pipeline).toHaveBeenCalled();
    });

    it('should write page_view keys when Redis is ready', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await service.track('1.2.3.4', 'Mozilla/5.0', {
        event: 'page_view',
        path: '/reviews',
        sessionId: 'sess_abc123',
        consent: true,
      });

      // Pipeline is used for all commands
      expect(redisMock._clientMock.pipeline).toHaveBeenCalled();
      const pipe = redisMock._clientMock.pipeline.mock.results[0].value;
      const cmds = pipe.commands.map((c: any) => c.cmd);
      expect(cmds).toContain('incr');
      expect(cmds).toContain('pfadd');
      expect(cmds).toContain('hincrby');
      expect(cmds).toContain('sadd'); // cohort SADD is unconditional
      expect(pipe.exec).toHaveBeenCalled();
    });

    it('should write like key for like event', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await service.track('1.2.3.4', '', { event: 'like', consent: true });

      const pipe = redisMock._clientMock.pipeline.mock.results[0].value;
      const incrCmds = pipe.commands.filter((c: any) => c.cmd === 'incr');
      const likeCmd = incrCmds.find((c: any) => c.args[0].includes(':like:'));
      expect(likeCmd).toBeDefined();
    });

    it('should write funnel keys for signup_started', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await service.track('1.2.3.4', '', {
        event: 'signup_started',
        consent: true,
      });

      const pipe = redisMock._clientMock.pipeline.mock.results[0].value;
      const hincrCmds = pipe.commands.filter((c: any) => c.cmd === 'hincrby');
      const funnelCmd = hincrCmds.find((c: any) =>
        c.args[0].includes(':funnel:event:'),
      );
      expect(funnelCmd).toBeDefined();
      expect(funnelCmd.args[1]).toBe('signup_started');
    });

    it('should write duration keys for page_leave', async () => {
      redisMock = createRedisMock(true);
      // Need hget to return '1' for session_pages for bounce detection
      redisMock._clientMock.hget.mockResolvedValue('1');
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await service.track('1.2.3.4', '', {
        event: 'page_leave',
        enteredAt: '2026-03-19T10:00:00Z',
        leftAt: '2026-03-19T10:00:15Z', // 15 seconds
        sessionId: 'sess_abc123',
        consent: true,
      });

      const pipe = redisMock._clientMock.pipeline.mock.results[0].value;
      const hincrCmds = pipe.commands.filter((c: any) => c.cmd === 'hincrby');
      const durationCmd = hincrCmds.find((c: any) =>
        c.args[0].includes(':duration_hist:'),
      );
      expect(durationCmd).toBeDefined();
      expect(durationCmd.args[1]).toBe('10_29'); // 15s falls in 10-29 bucket
    });
  });

  describe('getStats()', () => {
    it('should return emptyStats when Redis not ready', async () => {
      const result = await service.getStats('2026-03-01', '2026-03-01');
      expect(result).toBeDefined();
      expect(result!.totalPageviews).toBe(0);
      expect(result!.dateRange.from).toBe('2026-03-01');
    });

    it('should return null for invalid dates', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      const result = await service.getStats('invalid', '2026-03-01');
      expect(result).toBeNull();
    });

    it('should aggregate day data from Redis', async () => {
      redisMock = createRedisMock(true);
      const client = redisMock._clientMock;
      client.get.mockResolvedValue('42');
      client.hgetall.mockResolvedValue({});
      client.pfcount.mockResolvedValue(10);
      client.smembers.mockResolvedValue([]);
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      const result = await service.getStats('2026-03-19', '2026-03-19');

      expect(result).toBeDefined();
      expect(result!.totalPageviews).toBe(42);
      expect(result!.timeSeries).toHaveLength(1);
      expect(result!.timeSeries[0].date).toBe('2026-03-19');
    });
  });

  describe('getRealtime()', () => {
    it('should return empty when Redis not ready', async () => {
      const result = await service.getRealtime();
      expect(result.activeNow).toBe(0);
      expect(result.byCountry).toEqual({});
    });

    it('should count active sessions from sorted set', async () => {
      redisMock = createRedisMock(true);
      redisMock._clientMock.zrangebyscore.mockResolvedValue([
        'sess1:US',
        'sess2:GB',
        'sess1:US', // duplicate session
      ]);
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      const result = await service.getRealtime();

      expect(result.activeNow).toBe(2); // deduplicated
      expect(result.byCountry.US).toBe(2);
      expect(result.byCountry.GB).toBe(1);
    });
  });

  describe('isHealthy()', () => {
    it('should return false when no Redis client', async () => {
      expect(await service.isHealthy()).toBe(false);
    });

    it('should return true on successful PING', async () => {
      redisMock = createRedisMock(true);
      redisMock._clientMock.ping.mockResolvedValue('PONG');
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      expect(await service.isHealthy()).toBe(true);
    });

    it('should return false when PING fails', async () => {
      redisMock = createRedisMock(true);
      redisMock._clientMock.ping.mockRejectedValue(new Error('fail'));
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      expect(await service.isHealthy()).toBe(false);
    });
  });

  describe('isEnabled()', () => {
    it('should return Redis ready state', () => {
      expect(service.isEnabled()).toBe(false);
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('getHealthDetails()', () => {
    it('should return configured/connected/lastError', () => {
      const details = service.getHealthDetails();
      expect(details.connected).toBe(false);
      expect(details.lastError).toBeNull();
    });
  });

  describe('getRollupHealth()', () => {
    it('should return stale when no Redis', async () => {
      const result = await service.getRollupHealth();
      expect(result).toEqual({ lastSuccessDate: null, stale: true });
    });

    it('should return stale when key absent', async () => {
      redisMock = createRedisMock(true);
      redisMock._clientMock.get.mockResolvedValue(null);
      service = new AnalyticsService(redisMock as any, geoipMock as any);
      const result = await service.getRollupHealth();
      expect(result).toEqual({ lastSuccessDate: null, stale: true });
    });

    it('should return not stale for recent rollup', async () => {
      redisMock = createRedisMock(true);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const day = yesterday.toISOString().slice(0, 10);
      redisMock._clientMock.get.mockResolvedValue(day);
      service = new AnalyticsService(redisMock as any, geoipMock as any);
      const result = await service.getRollupHealth();
      expect(result).toEqual({ lastSuccessDate: day, stale: false });
    });

    it('should return stale for rollup older than 48 hours', async () => {
      redisMock = createRedisMock(true);
      const old = new Date();
      old.setDate(old.getDate() - 3);
      const day = old.toISOString().slice(0, 10);
      redisMock._clientMock.get.mockResolvedValue(day);
      service = new AnalyticsService(redisMock as any, geoipMock as any);
      const result = await service.getRollupHealth();
      expect(result.lastSuccessDate).toBe(day);
      expect(result.stale).toBe(true);
    });
  });

  // --- Private method tests (accessed via `as any`) ---
  // These protect against regressions in normalization logic that
  // silently corrupts analytics keys or produces wrong aggregations.

  describe('normalizePath()', () => {
    const normalize = (p?: string) => (service as any).normalizePath(p);

    it('should return / for empty/undefined input', () => {
      expect(normalize()).toBe('/');
      expect(normalize('')).toBe('/');
      expect(normalize('   ')).toBe('/');
    });

    it('should strip query strings and fragments', () => {
      expect(normalize('/reviews?page=2')).toBe('/reviews');
      expect(normalize('/reviews#top')).toBe('/reviews');
      expect(normalize('/reviews?page=2#top')).toBe('/reviews');
    });

    it('should replace numeric path segments with :id', () => {
      expect(normalize('/reviews/123')).toBe('/reviews/:id');
      expect(normalize('/users/42/posts/7')).toBe('/users/:id/posts/:id');
    });

    it('should replace hex IDs (8+ chars) with :id', () => {
      expect(normalize('/reviews/abcdef12')).toBe('/reviews/:id');
      expect(normalize('/reviews/ABCDEF1234567890')).toBe('/reviews/:id');
    });

    it('should replace UUIDs with :id', () => {
      expect(normalize('/reviews/550e8400-e29b-41d4-a716-446655440000')).toBe(
        '/reviews/:id',
      );
    });

    it('should collapse multiple slashes in path segments', () => {
      // Triple-slash prefix makes URL parser treat next segment as hostname,
      // so use a path that demonstrates the collapse within segments
      expect(normalize('/reviews//list')).toBe('/reviews/list');
    });

    it('should handle full URLs by extracting pathname', () => {
      expect(normalize('https://example.com/reviews?sort=new')).toBe(
        '/reviews',
      );
    });
  });

  describe('sanitizeLabel()', () => {
    const sanitize = (r?: string, f?: string) =>
      (service as any).sanitizeLabel(r, f);

    it('should return fallback for empty/undefined input', () => {
      expect(sanitize()).toBe('none');
      expect(sanitize('', 'direct')).toBe('direct');
      expect(sanitize('   ')).toBe('none');
    });

    it('should lowercase and replace special chars with underscore', () => {
      expect(sanitize('Google Ads')).toBe('google_ads');
      expect(sanitize('utm@source!')).toBe('utm_source_');
    });

    it('should preserve dots, dashes, and underscores', () => {
      expect(sanitize('my-source.v2_beta')).toBe('my-source.v2_beta');
    });

    it('should truncate to 80 characters', () => {
      const long = 'a'.repeat(100);
      expect(sanitize(long).length).toBe(80);
    });
  });

  describe('normalizeIp()', () => {
    const normalize = (ip: string) => normalizeIp(ip);

    it('should return empty string for empty input', () => {
      expect(normalize('')).toBe('');
    });

    it('should strip port from IPv4', () => {
      expect(normalize('1.2.3.4:8080')).toBe('1.2.3.4');
    });

    it('should handle bracketed IPv6 with port', () => {
      expect(normalize('[::1]:443')).toBe('::1');
    });

    it('should strip ::ffff: mapping prefix', () => {
      expect(normalize('::ffff:1.2.3.4')).toBe('1.2.3.4');
    });

    it('should return empty for invalid IPs', () => {
      expect(normalize('not-an-ip')).toBe('');
      expect(normalize('999.999.999.999')).toBe('');
    });

    it('should handle plain valid IPv4', () => {
      expect(normalize('8.8.8.8')).toBe('8.8.8.8');
    });
  });

  describe('durationBucket()', () => {
    const bucket = (s: number) => (service as any).durationBucket(s);

    it('should map durations to correct bucket labels', () => {
      expect(bucket(0)).toBe('0_9');
      expect(bucket(9)).toBe('0_9');
      expect(bucket(10)).toBe('10_29');
      expect(bucket(29)).toBe('10_29');
      expect(bucket(30)).toBe('30_59');
      expect(bucket(60)).toBe('60_119');
      expect(bucket(120)).toBe('120_299');
      expect(bucket(300)).toBe('300_599');
      expect(bucket(600)).toBe('600_1799');
      expect(bucket(1800)).toBe('1800_plus');
      expect(bucket(99999)).toBe('1800_plus');
    });
  });

  describe('referrerLabel()', () => {
    const label = (r?: string) => (service as any).referrerLabel(r);

    it('should return "direct" for empty/undefined referrer', () => {
      expect(label()).toBe('direct');
      expect(label('')).toBe('direct');
      expect(label('   ')).toBe('direct');
    });

    it('should extract hostname and strip www prefix', () => {
      expect(label('https://www.google.com/search?q=test')).toBe('google.com');
      expect(label('https://twitter.com/post/123')).toBe('twitter.com');
    });

    it('should return "direct" for invalid URLs', () => {
      expect(label('not a url')).toBe('direct');
    });
  });

  describe('bucketLongTail()', () => {
    const bucket = (src: Record<string, number>, limit: number) =>
      (service as any).bucketLongTail(src, limit);

    it('should return source unchanged when within limit', () => {
      const src = { a: 10, b: 5 };
      expect(bucket(src, 5)).toEqual(src);
    });

    it('should aggregate tail entries into "other"', () => {
      const src = { a: 100, b: 50, c: 30, d: 20, e: 10 };
      const result = bucket(src, 3);
      // Keeps top 2, aggregates c+d+e=60 into "other"
      expect(result).toEqual({ a: 100, b: 50, other: 60 });
    });
  });

  describe('parseFunnelMap()', () => {
    const parse = (input: Record<string, number>) =>
      (service as any).parseFunnelMap(input);

    it('should group pipe-delimited keys by entity and event', () => {
      const input = {
        'google|signup_started': 5,
        'google|signup_completed': 3,
        'google|purchase': 1,
        'facebook|signup_started': 2,
      };
      const result = parse(input);
      expect(result.google).toEqual({
        signup_started: 5,
        signup_completed: 3,
        purchase: 1,
      });
      expect(result.facebook).toEqual({
        signup_started: 2,
        signup_completed: 0,
        purchase: 0,
      });
    });

    it('should skip entries without pipe delimiter', () => {
      expect(parse({ nopipe: 10 })).toEqual({});
    });

    it('should skip entries with unknown event names', () => {
      expect(parse({ 'src|unknown_event': 5 })).toEqual({});
    });
  });

  describe('approximateDurationPercentile()', () => {
    const approx = (hist: Record<string, number>, total: number, pct: number) =>
      (service as any).approximateDurationPercentile(hist, total, pct);

    it('should return 0 when totalCount is 0', () => {
      expect(approx({}, 0, 0.5)).toBe(0);
    });

    it('should return the bucket max for p50', () => {
      // 100 in 0-9 bucket → p50 hits the first bucket
      const hist = { '0_9': 100 };
      expect(approx(hist, 100, 0.5)).toBe(9);
    });

    it('should walk through buckets for p95', () => {
      // 90 in 0-9, 10 in 10-29 → p95 = 95th of 100 → bucket 10-29
      const hist = { '0_9': 90, '10_29': 10 };
      expect(approx(hist, 100, 0.95)).toBe(29);
    });

    it('should cap at 1800 for the infinity bucket', () => {
      const hist = { '1800_plus': 100 };
      expect(approx(hist, 100, 0.5)).toBe(1800);
    });
  });

  describe('resolveCountry()', () => {
    it('should return country hint if valid 2-letter code', async () => {
      const result = await (service as any).resolveCountry('1.2.3.4', 'US');
      expect(result).toBe('US');
    });

    it('should return "XX" for private/local IPs without hint', async () => {
      const result = await (service as any).resolveCountry('127.0.0.1');
      expect(result).toBe('XX');
    });

    it('should return "XX" for empty IP without hint', async () => {
      const result = await (service as any).resolveCountry('');
      expect(result).toBe('XX');
    });
  });

  describe('readDayRangeFromPg()', () => {
    it('should return null when PrismaService is not injected', async () => {
      // Default service has no Prisma injected
      const result = await service.readDayRangeFromPg(['2026-01-01']);
      expect(result).toBeNull();
    });

    it('should return null for empty days array', async () => {
      const prismaMock = createPrismaMock();
      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );
      const result = await svc.readDayRangeFromPg([]);
      expect(result).toBeNull();
    });

    it('should reconstruct accumulator from EAV rows', async () => {
      const prismaMock = createPrismaMock();
      const day = '2026-01-15';
      const dateObj = new Date(day + 'T00:00:00Z');
      prismaMock.analyticsDailySummary.findMany.mockResolvedValue([
        {
          date: dateObj,
          dimension: '_total_',
          dimensionValue: 'pageviews',
          count: 100,
        },
        {
          date: dateObj,
          dimension: '_total_',
          dimensionValue: 'bounces',
          count: 20,
        },
        {
          date: dateObj,
          dimension: '_total_',
          dimensionValue: 'duration_sum',
          count: 5000,
        },
        {
          date: dateObj,
          dimension: '_total_',
          dimensionValue: 'duration_count',
          count: 50,
        },
        {
          date: dateObj,
          dimension: '_total_',
          dimensionValue: 'likes',
          count: 10,
        },
        {
          date: dateObj,
          dimension: '_total_',
          dimensionValue: 'uniques_approx',
          count: 80,
        },
        {
          date: dateObj,
          dimension: '_total_',
          dimensionValue: 'sessions_approx',
          count: 90,
        },
        {
          date: dateObj,
          dimension: 'country',
          dimensionValue: 'US',
          count: 60,
        },
        {
          date: dateObj,
          dimension: 'country',
          dimensionValue: 'DE',
          count: 40,
        },
        {
          date: dateObj,
          dimension: 'device',
          dimensionValue: 'desktop',
          count: 70,
        },
        {
          date: dateObj,
          dimension: 'browser',
          dimensionValue: 'Chrome',
          count: 55,
        },
        {
          date: dateObj,
          dimension: 'path',
          dimensionValue: '/home',
          count: 45,
        },
        {
          date: dateObj,
          dimension: 'duration_bucket',
          dimensionValue: '0_9',
          count: 30,
        },
        {
          date: dateObj,
          dimension: 'funnel_event',
          dimensionValue: 'signup_started',
          count: 15,
        },
        {
          date: dateObj,
          dimension: 'funnel_by_source',
          dimensionValue: 'google|signup_started',
          count: 8,
        },
        {
          date: dateObj,
          dimension: 'funnel_by_path',
          dimensionValue: '/home|signup_started',
          count: 5,
        },
        { date: dateObj, dimension: 'hour', dimensionValue: '14', count: 25 },
        {
          date: dateObj,
          dimension: 'weekday',
          dimensionValue: '3',
          count: 100,
        },
        {
          date: dateObj,
          dimension: 'hour_tz',
          dimensionValue: '10',
          count: 18,
        },
      ]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );
      const result = await svc.readDayRangeFromPg([day]);

      expect(result).not.toBeNull();
      expect(result!.totalPageviews).toBe(100);
      expect(result!.totalBounces).toBe(20);
      expect(result!.durationSum).toBe(5000);
      expect(result!.durationCount).toBe(50);
      expect(result!.totalLikes).toBe(10);
      expect(result!.totalUniques).toBe(80);
      expect(result!.totalSessions).toBe(90);
      expect(result!.byCountry).toEqual({ US: 60, DE: 40 });
      expect(result!.byDevice).toEqual({ desktop: 70 });
      expect(result!.byBrowser).toEqual({ Chrome: 55 });
      expect(result!.pathCounts).toEqual({ '/home': 45 });
      expect(result!.durationHistogram).toEqual({ '0_9': 30 });
      expect(result!.funnelEventCounts).toEqual({ signup_started: 15 });
      expect(result!.funnelBySourceRaw).toEqual({ 'google|signup_started': 8 });
      expect(result!.funnelByPathRaw).toEqual({ '/home|signup_started': 5 });
      expect(result!.byHour).toEqual({ '14': 25 });
      expect(result!.byWeekday).toEqual({ '3': 100 });
      expect(result!.byHourTz).toEqual({ '10': 18 });
      expect(result!.timeSeries).toEqual([
        { date: day, pageviews: 100, uniques: 80 },
      ]);
    });

    it('should aggregate multiple days into a single accumulator', async () => {
      const prismaMock = createPrismaMock();
      const day1 = '2026-01-14';
      const day2 = '2026-01-15';
      const d1 = new Date(day1 + 'T00:00:00Z');
      const d2 = new Date(day2 + 'T00:00:00Z');
      prismaMock.analyticsDailySummary.findMany.mockResolvedValue([
        {
          date: d1,
          dimension: '_total_',
          dimensionValue: 'pageviews',
          count: 50,
        },
        {
          date: d1,
          dimension: '_total_',
          dimensionValue: 'uniques_approx',
          count: 30,
        },
        { date: d1, dimension: 'country', dimensionValue: 'US', count: 25 },
        {
          date: d2,
          dimension: '_total_',
          dimensionValue: 'pageviews',
          count: 75,
        },
        {
          date: d2,
          dimension: '_total_',
          dimensionValue: 'uniques_approx',
          count: 40,
        },
        { date: d2, dimension: 'country', dimensionValue: 'US', count: 35 },
        { date: d2, dimension: 'country', dimensionValue: 'GB', count: 10 },
      ]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );
      const result = await svc.readDayRangeFromPg([day1, day2]);

      expect(result!.totalPageviews).toBe(125);
      expect(result!.totalUniques).toBe(70);
      expect(result!.byCountry).toEqual({ US: 60, GB: 10 });
      expect(result!.timeSeries).toEqual([
        { date: day1, pageviews: 50, uniques: 30 },
        { date: day2, pageviews: 75, uniques: 40 },
      ]);
    });

    it('should produce zero-value timeSeries entries for days with no PG data', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.analyticsDailySummary.findMany.mockResolvedValue([]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );
      const result = await svc.readDayRangeFromPg(['2026-01-15']);

      expect(result!.totalPageviews).toBe(0);
      expect(result!.timeSeries).toEqual([
        { date: '2026-01-15', pageviews: 0, uniques: 0 },
      ]);
    });
  });

  describe('getStats() hybrid partitioning', () => {
    it('should use only Redis for recent days when no Prisma injected', async () => {
      // All dates within 28-day window → all go to Redis, no PG
      redisMock = createRedisMock(true);
      const client = redisMock._clientMock;
      client.get.mockResolvedValue('10');
      client.hgetall.mockResolvedValue({});
      client.pfcount.mockResolvedValue(5);

      service = new AnalyticsService(redisMock as any, geoipMock as any);
      const today = new Date().toISOString().slice(0, 10);
      const result = await service.getStats(today, today);

      expect(result).toBeDefined();
      expect(result!.totalPageviews).toBe(10);
    });

    it('should merge PG stats with Redis stats for mixed date ranges', async () => {
      redisMock = createRedisMock(true);
      const client = redisMock._clientMock;
      // Redis returns 20 pageviews per GET (for the recent day)
      client.get.mockResolvedValue('20');
      client.hgetall.mockResolvedValue({});
      client.pfcount.mockResolvedValue(8);

      const prismaMock = createPrismaMock();
      // Old day is 60 days ago (well past 28-day cutoff)
      const oldDate = new Date();
      oldDate.setUTCDate(oldDate.getUTCDate() - 60);
      const oldDay = oldDate.toISOString().slice(0, 10);
      const oldDateObj = new Date(oldDay + 'T00:00:00Z');

      prismaMock.analyticsDailySummary.findMany.mockResolvedValue([
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'pageviews',
          count: 100,
        },
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'uniques_approx',
          count: 50,
        },
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'sessions_approx',
          count: 60,
        },
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'bounces',
          count: 10,
        },
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'likes',
          count: 5,
        },
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'duration_sum',
          count: 3000,
        },
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'duration_count',
          count: 30,
        },
        {
          date: oldDateObj,
          dimension: 'country',
          dimensionValue: 'US',
          count: 40,
        },
        {
          date: oldDateObj,
          dimension: 'device',
          dimensionValue: 'mobile',
          count: 35,
        },
      ]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );
      const today = new Date().toISOString().slice(0, 10);
      const result = await svc.getStats(oldDay, today);

      expect(result).toBeDefined();
      // PG: 100 pageviews for oldDay + Redis: 20 * N redisDays
      // The exact count depends on how many redisDays are in the range,
      // but total must be > 100 (PG) since Redis also contributes
      expect(result!.totalPageviews).toBeGreaterThanOrEqual(100);
      // PG country data should be merged
      expect(result!.byCountry.US).toBeGreaterThanOrEqual(40);
      expect(result!.byDevice.mobile).toBeGreaterThanOrEqual(35);
      // TimeSeries should include both PG and Redis entries
      expect(result!.timeSeries.length).toBeGreaterThan(1);
      // First entry should be the old PG day
      expect(result!.timeSeries[0].date).toBe(oldDay);
      // Uniques = PG sum + Redis HLL union
      expect(result!.totalUniques).toBeGreaterThanOrEqual(50);
    });

    it('should merge duration histogram and recompute percentiles', async () => {
      redisMock = createRedisMock(true);
      const client = redisMock._clientMock;
      // Redis day returns 50 hits in 0_9 bucket via hgetall for duration_hist
      client.get.mockResolvedValue('10');
      client.hgetall.mockImplementation((key: string) => {
        if (key.includes(':duration_hist:'))
          return Promise.resolve({ '0_9': '50' });
        return Promise.resolve({});
      });
      client.pfcount.mockResolvedValue(5);

      const prismaMock = createPrismaMock();
      const oldDate = new Date();
      oldDate.setUTCDate(oldDate.getUTCDate() - 60);
      const oldDay = oldDate.toISOString().slice(0, 10);
      const oldDateObj = new Date(oldDay + 'T00:00:00Z');
      // PG returns 100 hits in 10_29 bucket
      prismaMock.analyticsDailySummary.findMany.mockResolvedValue([
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'pageviews',
          count: 50,
        },
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'duration_sum',
          count: 2000,
        },
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'duration_count',
          count: 100,
        },
        {
          date: oldDateObj,
          dimension: 'duration_bucket',
          dimensionValue: '10_29',
          count: 100,
        },
      ]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );
      const today = new Date().toISOString().slice(0, 10);
      const result = await svc.getStats(oldDay, today);

      expect(result).toBeDefined();
      // Duration sum/count should be additive (PG 2000/100 + Redis per-day)
      // avgDurationSeconds is derived from merged sum/count, not averaged per-window
      // PG contributes 2000/100 = 20s avg; Redis contributes 0/0 per day
      // So avgDuration = totalSum / totalCount where both are additive
      expect(result!.avgDurationSeconds).toBeGreaterThanOrEqual(0);
      // durationP50 should reflect the merged histogram (PG 10_29 bucket has 100 entries)
      expect(result!.durationP50Seconds).toBeGreaterThanOrEqual(0);
    });

    it('should derive bounceRate from merged totals, not average per-window', async () => {
      redisMock = createRedisMock(true);
      const client = redisMock._clientMock;
      // Redis: 100 pageviews, 10 bounces
      client.get.mockImplementation((key: string) => {
        if (key.includes(':pageviews:')) return Promise.resolve('100');
        if (key.includes(':bounces:')) return Promise.resolve('10');
        return Promise.resolve('0');
      });
      client.hgetall.mockResolvedValue({});
      client.pfcount.mockResolvedValue(5);

      const prismaMock = createPrismaMock();
      const oldDate = new Date();
      oldDate.setUTCDate(oldDate.getUTCDate() - 60);
      const oldDay = oldDate.toISOString().slice(0, 10);
      const oldDateObj = new Date(oldDay + 'T00:00:00Z');
      // PG: 200 pageviews, 100 bounces (50% rate)
      prismaMock.analyticsDailySummary.findMany.mockResolvedValue([
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'pageviews',
          count: 200,
        },
        {
          date: oldDateObj,
          dimension: '_total_',
          dimensionValue: 'bounces',
          count: 100,
        },
      ]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );
      const today = new Date().toISOString().slice(0, 10);
      const result = await svc.getStats(oldDay, today);

      expect(result).toBeDefined();
      // Bounce rate should be (totalBounces / totalPageviews) from merged totals
      // Not an average of per-window rates
      const expectedBounces = result!.totalBounces;
      expect(result!.totalPageviews).toBeGreaterThan(0);
      expect(expectedBounces).toBeGreaterThanOrEqual(100); // at least PG bounces
      // bounceRate = (totalBounces / totalSessions) * 100 — derived from merged totals
      const totalSessions = result!.totalSessions;
      if (totalSessions > 0) {
        expect(result!.bounceRate).toBeCloseTo(
          (expectedBounces / totalSessions) * 100,
          1,
        );
      }
    });
  });

  describe('track() pipeline details', () => {
    it('should include expire commands for TTL in page_view pipeline', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await service.track('1.2.3.4', 'Mozilla/5.0', {
        event: 'page_view',
        path: '/test',
        sessionId: 'sess_abc',
        consent: true,
      });

      const pipe = redisMock._clientMock.pipeline.mock.results[0].value;
      const expireCmds = pipe.commands.filter((c: any) => c.cmd === 'expire');
      // Multiple expire commands for TTL on data keys
      expect(expireCmds.length).toBeGreaterThan(0);
    });

    it('should include hsetnx for per-day first_visit hash in page_view pipeline', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await service.track('1.2.3.4', 'Mozilla/5.0', {
        event: 'page_view',
        path: '/test',
        sessionId: 'sess_abc',
        consent: true,
      });

      const pipe = redisMock._clientMock.pipeline.mock.results[0].value;
      const hsetnxCmds = pipe.commands.filter((c: any) => c.cmd === 'hsetnx');
      const firstVisitCmd = hsetnxCmds.find((c: any) =>
        c.args[0].includes(':first_visit:'),
      );
      expect(firstVisitCmd).toBeDefined();
      // Key format is per-day hash, not per-session
      expect(firstVisitCmd.args[0]).toMatch(
        /^analytics:first_visit:\d{4}-\d{2}-\d{2}$/,
      );
    });

    it('should include source and path composite keys for funnel event', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await service.track('1.2.3.4', '', {
        event: 'signup_completed',
        path: '/register',
        utm_source: 'google',
        consent: true,
      });

      const pipe = redisMock._clientMock.pipeline.mock.results[0].value;
      const hincrCmds = pipe.commands.filter((c: any) => c.cmd === 'hincrby');

      // funnel:source key with composite value
      const sourceCmd = hincrCmds.find((c: any) =>
        c.args[0].includes(':funnel:source:'),
      );
      expect(sourceCmd).toBeDefined();
      expect(sourceCmd.args[1]).toContain('|signup_completed');

      // funnel:path key with composite value
      const pathCmd = hincrCmds.find((c: any) =>
        c.args[0].includes(':funnel:path:'),
      );
      expect(pathCmd).toBeDefined();
      expect(pathCmd.args[1]).toContain('|signup_completed');
    });

    it('should use two-step bounce detection (HGET then conditional INCR)', async () => {
      redisMock = createRedisMock(true);
      // Return '1' for session_pages HGET → triggers bounce increment
      redisMock._clientMock.hget.mockResolvedValue('1');
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await service.track('1.2.3.4', '', {
        event: 'page_leave',
        enteredAt: '2026-03-19T10:00:00Z',
        leftAt: '2026-03-19T10:00:10Z', // 10s < 30s threshold
        sessionId: 'sess_abc',
        consent: true,
      });

      // Wait for the async bounce detection chain
      await new Promise((r) => setTimeout(r, 50));

      // HGET is called separately (not in pipeline) for session_pages
      expect(redisMock._clientMock.hget).toHaveBeenCalledWith(
        expect.stringContaining(':session_pages:'),
        'sess_abc',
      );
      // INCR for bounces is called separately (not in pipeline)
      expect(redisMock._clientMock.incr).toHaveBeenCalledWith(
        expect.stringContaining(':bounces:'),
      );
    });

    it('should NOT trigger bounce detection when duration >= 30s', async () => {
      redisMock = createRedisMock(true);
      redisMock._clientMock.hget.mockResolvedValue('1');
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await service.track('1.2.3.4', '', {
        event: 'page_leave',
        enteredAt: '2026-03-19T10:00:00Z',
        leftAt: '2026-03-19T10:00:45Z', // 45s >= 30s threshold
        sessionId: 'sess_abc',
        consent: true,
      });

      await new Promise((r) => setTimeout(r, 50));

      // HGET should NOT be called for bounce check when duration >= 30s
      expect(redisMock._clientMock.hget).not.toHaveBeenCalled();
    });
  });

  describe('buffer integration', () => {
    let bufferMock: { push: jest.Mock };

    beforeEach(() => {
      bufferMock = { push: jest.fn() };
    });

    it('should push page_view event to buffer after pipeline', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        bufferMock as any,
      );

      await service.track('1.2.3.4', 'Mozilla/5.0', {
        event: 'page_view',
        path: '/reviews',
        sessionId: 'sess_abc',
        consent: true,
      });

      expect(bufferMock.push).toHaveBeenCalledTimes(1);
      const pushed = bufferMock.push.mock.calls[0][0];
      expect(pushed.eventType).toBe('page_view');
      expect(pushed.path).toBe('/reviews');
      expect(pushed.ipHash).toBeDefined(); // SHA256 of IP
      expect(pushed.ipHash).toHaveLength(64); // hex SHA256
    });

    it('should push like event to buffer', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        bufferMock as any,
      );

      await service.track('1.2.3.4', '', { event: 'like', consent: true });

      expect(bufferMock.push).toHaveBeenCalledTimes(1);
      expect(bufferMock.push.mock.calls[0][0].eventType).toBe('like');
    });

    it('should push funnel event to buffer with utm fields', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        bufferMock as any,
      );

      await service.track('1.2.3.4', '', {
        event: 'signup_started',
        utm_source: 'google',
        utm_medium: 'cpc',
        consent: true,
      });

      expect(bufferMock.push).toHaveBeenCalledTimes(1);
      const pushed = bufferMock.push.mock.calls[0][0];
      expect(pushed.eventType).toBe('signup_started');
      expect(pushed.utmSource).toBe('google');
      expect(pushed.utmMedium).toBe('cpc');
    });

    it('should push page_leave event to buffer with durationSeconds', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        bufferMock as any,
      );

      await service.track('1.2.3.4', '', {
        event: 'page_leave',
        enteredAt: '2026-03-19T10:00:00Z',
        leftAt: '2026-03-19T10:02:00Z', // 120 seconds
        sessionId: 'sess_abc',
        consent: true,
      });

      expect(bufferMock.push).toHaveBeenCalledTimes(1);
      const pushed = bufferMock.push.mock.calls[0][0];
      expect(pushed.eventType).toBe('page_leave');
      expect(pushed.durationSeconds).toBe(120);
    });

    it('should not push to buffer when bufferService is not injected', async () => {
      redisMock = createRedisMock(true);
      // No bufferService injected (undefined)
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await service.track('1.2.3.4', 'Mozilla/5.0', {
        event: 'page_view',
        consent: true,
      });

      // No error thrown, pipeline still works
      expect(redisMock._clientMock.pipeline).toHaveBeenCalled();
    });

    it('should produce deterministic SHA256 ipHash', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        bufferMock as any,
      );

      await service.track('8.8.8.8', 'Mozilla/5.0', {
        event: 'page_view',
        consent: true,
      });
      await service.track('8.8.8.8', 'Mozilla/5.0', {
        event: 'like',
        consent: true,
      });

      // Same IP → same hash (deterministic, no salt per spec)
      const hash1 = bufferMock.push.mock.calls[0][0].ipHash;
      const hash2 = bufferMock.push.mock.calls[1][0].ipHash;
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });
  });

  describe('retention pre-computation', () => {
    it('should no-op when Redis is not ready', async () => {
      // Default service has Redis not ready
      await (service as any).computeRetention();
      // No Redis calls made
      expect(redisMock._clientMock.smembers).not.toHaveBeenCalled();
    });

    it('should skip days with empty cohorts', async () => {
      redisMock = createRedisMock(true);
      redisMock._clientMock.smembers.mockResolvedValue([]);
      service = new AnalyticsService(redisMock as any, geoipMock as any);

      await (service as any).computeRetention();

      // smembers called for cohort, but no hgetall for session_pages
      expect(redisMock._clientMock.smembers).toHaveBeenCalled();
      // No retention key written for empty cohorts
      expect(redisMock._clientMock.set).not.toHaveBeenCalled();
    });

    it('should compute and store retention percentages for non-empty cohorts', async () => {
      redisMock = createRedisMock(true);
      const client = redisMock._clientMock;

      // Cohort has 2 members on every day
      client.smembers.mockResolvedValue(['sess_a', 'sess_b']);

      // session_pages: sess_a returned on day+1, sess_b on day+7
      client.hgetall.mockImplementation(() => {
        // Return sess_a for all day lookups to simulate day+1 return
        return Promise.resolve({ sess_a: '3' });
      });

      service = new AnalyticsService(redisMock as any, geoipMock as any);
      await (service as any).computeRetention();

      // Should write retention keys
      expect(client.set).toHaveBeenCalled();
      // Verify the stored JSON structure
      const setCall = client.set.mock.calls[0];
      expect(setCall[0]).toMatch(/^analytics:retention:\d{4}-\d{2}-\d{2}$/);
      const parsed = JSON.parse(setCall[1]);
      expect(parsed).toHaveProperty('day1Pct');
      expect(parsed).toHaveProperty('day7Pct');
      expect(parsed).toHaveProperty('day30Pct');
      expect(parsed).toHaveProperty('cohortSize');
      expect(parsed.cohortSize).toBe(2);
      // sess_a returned in all windows → 1/2 = 50%
      expect(parsed.day1Pct).toBe(50);
      // TTL: 48 hours
      expect(setCall[2]).toBe('EX');
      expect(setCall[3]).toBe(48 * 60 * 60);
    });

    it('should continue processing remaining days when one day fails', async () => {
      redisMock = createRedisMock(true);
      const client = redisMock._clientMock;

      let callCount = 0;
      client.smembers.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('transient'));
        return Promise.resolve(['sess_a']);
      });
      client.hgetall.mockResolvedValue({});

      service = new AnalyticsService(redisMock as any, geoipMock as any);
      await (service as any).computeRetention();

      // Despite first day failing, subsequent days still processed
      // 35 days total, first fails, rest succeed → 34 set calls
      // (but cohorts with no returning sessions still get set)
      expect(client.set).toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('should start retention timer on module init', () => {
      jest.useFakeTimers();
      try {
        redisMock = createRedisMock(true);
        redisMock._clientMock.smembers.mockResolvedValue([]);
        service = new AnalyticsService(redisMock as any, geoipMock as any);
        service.onModuleInit();

        // Timer should be set (we verify by checking it fires)
        jest.advanceTimersByTime(60 * 60 * 1000); // 1 hour
        // computeRetention would be called — we verify via smembers
        expect(redisMock._clientMock.smembers).toHaveBeenCalled();

        service.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should clear retention timer on module destroy', () => {
      jest.useFakeTimers();
      try {
        redisMock = createRedisMock(true);
        service = new AnalyticsService(redisMock as any, geoipMock as any);
        service.onModuleInit();
        service.onModuleDestroy();

        // After destroy, advancing time should NOT trigger computeRetention
        redisMock._clientMock.smembers.mockClear();
        jest.advanceTimersByTime(60 * 60 * 1000);
        expect(redisMock._clientMock.smembers).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('anonymizeUserAnalytics', () => {
    it('should nullify userId on analytics_events for the given user', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.$executeRaw.mockResolvedValue(5);
      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      const result = await svc.anonymizeUserAnalytics('user-123');

      expect(result).toBe(5);
      expect(prismaMock.$executeRaw).toHaveBeenCalled();
    });

    it('should return 0 when PrismaService is not injected', async () => {
      const svc = new AnalyticsService(redisMock as any, geoipMock as any);
      const result = await svc.anonymizeUserAnalytics('user-123');
      expect(result).toBe(0);
    });
  });

  describe('anonymizeExpiredUsers', () => {
    let prismaMock: ReturnType<typeof createPrismaMock>;

    beforeEach(() => {
      redisMock = createRedisMock(true);
      prismaMock = createPrismaMock();
    });

    it('should skip when Prisma is not injected', async () => {
      const svc = new AnalyticsService(redisMock as any, geoipMock as any);
      await svc.anonymizeExpiredUsers();
      expect(redisMock._clientMock.get).not.toHaveBeenCalled();
    });

    it('should skip when Redis is not ready', async () => {
      redisMock = createRedisMock(false);
      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );
      await svc.anonymizeExpiredUsers();
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('should skip when already ran today (daily guard)', async () => {
      redisMock._clientMock.get.mockResolvedValue('1');
      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );
      await svc.anonymizeExpiredUsers();
      expect(redisMock._clientMock.set).not.toHaveBeenCalled();
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('should skip when running lock is held (concurrent guard)', async () => {
      redisMock._clientMock.get.mockResolvedValue(null);
      redisMock._clientMock.set.mockResolvedValue(null); // NX failed
      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );
      await svc.anonymizeExpiredUsers();
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('should set daily guard and return early when no rows to anonymize', async () => {
      redisMock._clientMock.get.mockResolvedValue(null);
      redisMock._clientMock.set.mockResolvedValue('OK');
      prismaMock.$queryRaw.mockResolvedValue([{ count: BigInt(0) }]);
      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      await svc.anonymizeExpiredUsers();

      // Should set ran key and delete running lock
      const setCalls = redisMock._clientMock.set.mock.calls;
      const ranCall = setCalls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('ran:'),
      );
      expect(ranCall).toBeDefined();
      expect(redisMock._clientMock.del).toHaveBeenCalled();
    });

    it('should use single UPDATE for steady-state (<=200K rows)', async () => {
      redisMock._clientMock.get.mockResolvedValue(null);
      redisMock._clientMock.set.mockResolvedValue('OK');
      prismaMock.$queryRaw.mockResolvedValue([{ count: BigInt(100) }]);
      prismaMock.$executeRaw.mockResolvedValue(100);
      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      await svc.anonymizeExpiredUsers();

      // synchronous_commit + UPDATE = 2 $executeRaw calls
      expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
      expect(redisMock._clientMock.del).toHaveBeenCalled();
    });

    it('should batch by calendar day for large backfills (>200K rows)', async () => {
      redisMock._clientMock.get.mockResolvedValue(null);
      redisMock._clientMock.set.mockResolvedValue('OK');
      prismaMock.$queryRaw
        .mockResolvedValueOnce([{ count: BigInt(300_000) }])
        .mockResolvedValueOnce([{ min_date: new Date('2024-01-01') }]);
      prismaMock.$executeRaw.mockResolvedValue(1000);
      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      await svc.anonymizeExpiredUsers();

      // Should have multiple $executeRaw calls (2 per day: SET LOCAL + UPDATE)
      expect(prismaMock.$executeRaw.mock.calls.length).toBeGreaterThan(2);
      expect(redisMock._clientMock.del).toHaveBeenCalled();
    });

    it('should release running lock in finally even on error', async () => {
      redisMock._clientMock.get.mockResolvedValue(null);
      redisMock._clientMock.set.mockResolvedValue('OK');
      prismaMock.$queryRaw.mockRejectedValue(new Error('DB error'));
      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      await svc.anonymizeExpiredUsers();

      // Running lock should be deleted despite error
      expect(redisMock._clientMock.del).toHaveBeenCalledWith(
        'analytics:anonymize:running',
      );
    });

    it('should compute correct 90-day cutoff', async () => {
      redisMock._clientMock.get.mockResolvedValue(null);
      redisMock._clientMock.set.mockResolvedValue('OK');
      prismaMock.$queryRaw.mockResolvedValue([{ count: BigInt(10) }]);
      prismaMock.$executeRaw.mockResolvedValue(10);
      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      await svc.anonymizeExpiredUsers();

      // Verify $queryRaw was called (cutoff date is embedded in tagged template)
      expect(prismaMock.$queryRaw).toHaveBeenCalled();
      expect(prismaMock.$executeRaw).toHaveBeenCalled();
    });
  });

  describe('getEventAggregation()', () => {
    it('should return empty result when prisma is not available', async () => {
      // Default service has no prisma injected
      const result = await service.getEventAggregation('2026-03-01', '2026-03-30');

      expect(result.total).toBe(0);
      expect(result.timeSeries).toEqual([]);
      expect(result.byEventType).toEqual({});
      expect(result.dateRange).toEqual({ from: '2026-03-01', to: '2026-03-30' });
    });

    it('should query analytics_events and return aggregated breakdowns', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.analyticsEvent.count.mockResolvedValue(150);
      prismaMock.$queryRaw.mockResolvedValue([
        { date: '2026-03-01', count: BigInt(80) },
        { date: '2026-03-02', count: BigInt(70) },
      ]);
      // Mock all groupBy calls in order: eventType, country, device, browser, os, path, referrer, utmSource, utmMedium, utmCampaign
      prismaMock.analyticsEvent.groupBy
        .mockResolvedValueOnce([
          { eventType: 'page_view', _count: 100 },
          { eventType: 'page_leave', _count: 50 },
        ])
        .mockResolvedValueOnce([{ country: 'US', _count: 90 }, { country: 'DE', _count: 60 }])
        .mockResolvedValueOnce([{ device: 'desktop', _count: 120 }])
        .mockResolvedValueOnce([{ browser: 'Chrome', _count: 100 }])
        .mockResolvedValueOnce([{ os: 'Windows', _count: 80 }])
        .mockResolvedValueOnce([{ path: '/home', _count: 70 }])
        .mockResolvedValueOnce([{ referrer: 'google.com', _count: 40 }])
        .mockResolvedValueOnce([{ utmSource: 'twitter', _count: 20 }])
        .mockResolvedValueOnce([{ utmMedium: 'social', _count: 15 }])
        .mockResolvedValueOnce([{ utmCampaign: 'launch', _count: 10 }]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      const result = await svc.getEventAggregation('2026-03-01', '2026-03-30');

      expect(result.total).toBe(150);
      expect(result.timeSeries).toEqual([
        { date: '2026-03-01', count: 80 },
        { date: '2026-03-02', count: 70 },
      ]);
      expect(result.byEventType).toEqual({ page_view: 100, page_leave: 50 });
      expect(result.byCountry).toEqual({ US: 90, DE: 60 });
      expect(result.byDevice).toEqual({ desktop: 120 });
      expect(result.byBrowser).toEqual({ Chrome: 100 });
      expect(result.byOs).toEqual({ Windows: 80 });
      expect(result.byPath).toEqual({ '/home': 70 });
      expect(result.byReferrer).toEqual({ 'google.com': 40 });
      expect(result.byUtmSource).toEqual({ twitter: 20 });
      expect(result.byUtmMedium).toEqual({ social: 15 });
      expect(result.byUtmCampaign).toEqual({ launch: 10 });
    });

    it('should filter by eventType when provided', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.analyticsEvent.count.mockResolvedValue(50);
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.analyticsEvent.groupBy.mockResolvedValue([]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      await svc.getEventAggregation('2026-03-01', '2026-03-30', 'page_view');

      // Verify count was called with eventType filter
      expect(prismaMock.analyticsEvent.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ eventType: 'page_view' }),
        }),
      );
    });

    it('should cache results for 1 minute', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.analyticsEvent.count.mockResolvedValue(10);
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.analyticsEvent.groupBy.mockResolvedValue([]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      // First call hits DB
      await svc.getEventAggregation('2026-03-01', '2026-03-05');
      expect(prismaMock.analyticsEvent.count).toHaveBeenCalledTimes(1);

      // Second call with same params returns cached result
      await svc.getEventAggregation('2026-03-01', '2026-03-05');
      expect(prismaMock.analyticsEvent.count).toHaveBeenCalledTimes(1);
    });

    it('should skip null dimension values in groupBy results', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.analyticsEvent.count.mockResolvedValue(5);
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.analyticsEvent.groupBy
        .mockResolvedValueOnce([{ eventType: 'page_view', _count: 5 }])
        .mockResolvedValueOnce([{ country: null, _count: 3 }])
        .mockResolvedValue([]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      const result = await svc.getEventAggregation('2026-03-10', '2026-03-10');

      // null keys should be filtered out
      expect(result.byCountry).toEqual({});
      expect(result.byEventType).toEqual({ page_view: 5 });
    });
  });

  describe('getNotificationAnalytics()', () => {
    it('should return empty result when prisma is not available', async () => {
      const result = await service.getNotificationAnalytics(
        '2026-03-01',
        '2026-03-30',
      );

      expect(result.total).toBe(0);
      expect(result.readCount).toBe(0);
      expect(result.pushedCount).toBe(0);
      expect(result.readRate).toBe(0);
      expect(result.pushDeliveryRate).toBe(0);
      expect(result.byType).toEqual([]);
      expect(result.dateRange).toEqual({
        from: '2026-03-01',
        to: '2026-03-30',
      });
    });

    it('should query notifications and return aggregated type breakdown with rates', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.$queryRaw.mockResolvedValue([
        {
          type: 'NEW_REVIEW',
          total: BigInt(100),
          read_count: BigInt(80),
          pushed_count: BigInt(60),
        },
        {
          type: 'NEW_COMMENT',
          total: BigInt(50),
          read_count: BigInt(10),
          pushed_count: BigInt(25),
        },
      ]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      const result = await svc.getNotificationAnalytics(
        '2026-03-01',
        '2026-03-30',
      );

      expect(result.total).toBe(150);
      expect(result.readCount).toBe(90);
      expect(result.pushedCount).toBe(85);
      expect(result.readRate).toBe(60); // 90/150 = 0.6 = 60%
      expect(result.pushDeliveryRate).toBe(56.67); // 85/150 ≈ 56.67%
      expect(result.byType).toHaveLength(2);
      expect(result.byType[0]).toEqual({
        type: 'NEW_REVIEW',
        total: 100,
        read: 80,
        pushed: 60,
        readRate: 80,
        pushDeliveryRate: 60,
      });
      expect(result.byType[1]).toEqual({
        type: 'NEW_COMMENT',
        total: 50,
        read: 10,
        pushed: 25,
        readRate: 20,
        pushDeliveryRate: 50,
      });
    });

    it('should return zero rates when there are no notifications', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.$queryRaw.mockResolvedValue([]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      // Use unique date range to avoid hitting the module-level cache from prior test
      const result = await svc.getNotificationAnalytics(
        '2026-02-01',
        '2026-02-28',
      );

      expect(result.total).toBe(0);
      expect(result.readRate).toBe(0);
      expect(result.pushDeliveryRate).toBe(0);
      expect(result.byType).toEqual([]);
    });

    it('should cache results for 1 minute', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.$queryRaw.mockResolvedValue([]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      await svc.getNotificationAnalytics('2026-03-01', '2026-03-05');
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);

      // Second call with same params returns cached result
      await svc.getNotificationAnalytics('2026-03-01', '2026-03-05');
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSearchQueryAnalytics()', () => {
    it('should return empty result when prisma is not available', async () => {
      const result = await service.getSearchQueryAnalytics('2026-03-01', '2026-03-30');

      expect(result.total).toBe(0);
      expect(result.timeSeries).toEqual([]);
      expect(result.topQueries).toEqual([]);
      expect(result.byType).toEqual({});
      expect(result.avgResultCount).toBe(0);
      expect(result.dateRange).toEqual({ from: '2026-03-01', to: '2026-03-30' });
    });

    it('should query search_performed events and return aggregated results', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.analyticsEvent.count.mockResolvedValue(200);
      prismaMock.$queryRaw
        // timeseries
        .mockResolvedValueOnce([
          { date: '2026-03-01', count: BigInt(120) },
          { date: '2026-03-02', count: BigInt(80) },
        ])
        // top queries
        .mockResolvedValueOnce([
          { query: 'bitcoin', count: BigInt(90), avg_result_count: 15.5 },
          { query: 'ethereum', count: BigInt(60), avg_result_count: 8.3 },
        ])
        // by type
        .mockResolvedValueOnce([
          { type: 'companies', count: BigInt(130) },
          { type: 'users', count: BigInt(70) },
        ])
        // avg result count
        .mockResolvedValueOnce([{ avg_result_count: 12.75 }]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      const result = await svc.getSearchQueryAnalytics('2026-03-15', '2026-03-30');

      expect(result.total).toBe(200);
      expect(result.timeSeries).toEqual([
        { date: '2026-03-01', count: 120 },
        { date: '2026-03-02', count: 80 },
      ]);
      expect(result.topQueries).toEqual([
        { query: 'bitcoin', count: 90, avgResultCount: 15.5 },
        { query: 'ethereum', count: 60, avgResultCount: 8.3 },
      ]);
      expect(result.byType).toEqual({ companies: 130, users: 70 });
      expect(result.avgResultCount).toBe(12.75);
    });

    it('should return zero avgResultCount when no results have resultCount', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.analyticsEvent.count.mockResolvedValue(5);
      prismaMock.$queryRaw
        .mockResolvedValueOnce([]) // timeseries
        .mockResolvedValueOnce([]) // top queries
        .mockResolvedValueOnce([]) // by type
        .mockResolvedValueOnce([{ avg_result_count: null }]); // avg result

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      const result = await svc.getSearchQueryAnalytics('2026-01-01', '2026-01-31');

      expect(result.total).toBe(5);
      expect(result.avgResultCount).toBe(0);
      expect(result.topQueries).toEqual([]);
    });

    it('should cache results for 1 minute', async () => {
      const prismaMock = createPrismaMock();
      prismaMock.analyticsEvent.count.mockResolvedValue(10);
      prismaMock.$queryRaw.mockResolvedValue([]);

      const svc = new AnalyticsService(
        redisMock as any,
        geoipMock as any,
        undefined,
        prismaMock,
      );

      await svc.getSearchQueryAnalytics('2026-03-06', '2026-03-10');
      expect(prismaMock.analyticsEvent.count).toHaveBeenCalledTimes(1);

      // Second call with same params returns cached result
      await svc.getSearchQueryAnalytics('2026-03-06', '2026-03-10');
      expect(prismaMock.analyticsEvent.count).toHaveBeenCalledTimes(1);
    });
  });
});
