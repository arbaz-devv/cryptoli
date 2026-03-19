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
});
