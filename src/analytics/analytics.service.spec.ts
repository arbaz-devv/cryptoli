import { AnalyticsService } from './analytics.service';
import { createRedisMock } from '../../test/helpers/redis.mock';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let redisMock: ReturnType<typeof createRedisMock>;

  beforeEach(() => {
    redisMock = createRedisMock(false);
    service = new AnalyticsService(redisMock as any);
  });

  describe('track()', () => {
    it('should no-op when Redis is not ready', async () => {
      await service.track('1.2.3.4', 'Mozilla/5.0', { event: 'page_view' });
      expect(redisMock._clientMock.incr).not.toHaveBeenCalled();
    });

    it('should no-op when consent is false', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any);
      await service.track('1.2.3.4', 'Mozilla/5.0', {
        event: 'page_view',
        consent: false,
      });
      expect(redisMock._clientMock.incr).not.toHaveBeenCalled();
    });

    it('should write page_view keys when Redis is ready', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any);

      await service.track('1.2.3.4', 'Mozilla/5.0', {
        event: 'page_view',
        path: '/reviews',
        sessionId: 'sess_abc123',
      });

      // incr is called for pageviews key
      expect(redisMock._clientMock.incr).toHaveBeenCalled();
      // pfadd is called for HLL uniques
      expect(redisMock._clientMock.pfadd).toHaveBeenCalled();
      // hincrby is called for dimension hashes
      expect(redisMock._clientMock.hincrby).toHaveBeenCalled();
    });

    it('should write like key for like event', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any);

      await service.track('1.2.3.4', '', { event: 'like' });

      const incrCalls = redisMock._clientMock.incr.mock.calls;
      const likeCall = incrCalls.find((c: string[]) => c[0].includes(':like:'));
      expect(likeCall).toBeDefined();
    });

    it('should write funnel keys for signup_started', async () => {
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any);

      await service.track('1.2.3.4', '', { event: 'signup_started' });

      const hincrCalls = redisMock._clientMock.hincrby.mock.calls;
      const funnelCall = hincrCalls.find((c: any[]) =>
        c[0].includes(':funnel:event:'),
      );
      expect(funnelCall).toBeDefined();
      expect(funnelCall[1]).toBe('signup_started');
    });

    it('should write duration keys for page_leave', async () => {
      redisMock = createRedisMock(true);
      // Need hget to return '1' for session_pages for bounce detection
      redisMock._clientMock.hget.mockResolvedValue('1');
      service = new AnalyticsService(redisMock as any);

      await service.track('1.2.3.4', '', {
        event: 'page_leave',
        enteredAt: '2026-03-19T10:00:00Z',
        leftAt: '2026-03-19T10:00:15Z', // 15 seconds
        sessionId: 'sess_abc123',
      });

      const hincrCalls = redisMock._clientMock.hincrby.mock.calls;
      const durationCall = hincrCalls.find((c: any[]) =>
        c[0].includes(':duration_hist:'),
      );
      expect(durationCall).toBeDefined();
      expect(durationCall[1]).toBe('10_29'); // 15s falls in 10-29 bucket
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
      service = new AnalyticsService(redisMock as any);

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
      service = new AnalyticsService(redisMock as any);

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
      service = new AnalyticsService(redisMock as any);

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
      service = new AnalyticsService(redisMock as any);

      expect(await service.isHealthy()).toBe(true);
    });

    it('should return false when PING fails', async () => {
      redisMock = createRedisMock(true);
      redisMock._clientMock.ping.mockRejectedValue(new Error('fail'));
      service = new AnalyticsService(redisMock as any);

      expect(await service.isHealthy()).toBe(false);
    });
  });

  describe('isEnabled()', () => {
    it('should return Redis ready state', () => {
      expect(service.isEnabled()).toBe(false);
      redisMock = createRedisMock(true);
      service = new AnalyticsService(redisMock as any);
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
    const normalize = (ip: string) => (service as any).normalizeIp(ip);

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

    it('should return "unknown" for private/local IPs without hint', async () => {
      const result = await (service as any).resolveCountry('127.0.0.1');
      expect(result).toBe('unknown');
    });

    it('should return "unknown" for empty IP without hint', async () => {
      const result = await (service as any).resolveCountry('');
      expect(result).toBe('unknown');
    });
  });
});
