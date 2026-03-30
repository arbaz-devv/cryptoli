import 'reflect-metadata';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsGuard } from './analytics.guard';

describe('AnalyticsController', () => {
  let controller: AnalyticsController;
  let mockAnalyticsService: Record<string, jest.Mock>;
  let mockPrisma: Record<string, any>;

  beforeEach(() => {
    mockAnalyticsService = {
      track: jest.fn(),
      getStats: jest.fn().mockResolvedValue({ totalPageviews: 0 }),
      isHealthy: jest.fn().mockResolvedValue(true),
      getHealthDetails: jest.fn().mockReturnValue({
        configured: true,
        connected: true,
        lastError: null,
      }),
      getRealtime: jest.fn().mockResolvedValue({ activeNow: 5, byCountry: {} }),
      getRollupHealth: jest
        .fn()
        .mockResolvedValue({ lastSuccessDate: '2026-03-23', stale: false }),
      getEventAggregation: jest.fn().mockResolvedValue({
        total: 0,
        dateRange: { from: '2026-03-01', to: '2026-03-30' },
        timeSeries: [],
        byEventType: {},
        byCountry: {},
        byDevice: {},
        byBrowser: {},
        byOs: {},
        byPath: {},
        byReferrer: {},
        byUtmSource: {},
        byUtmMedium: {},
        byUtmCampaign: {},
      }),
    };
    mockPrisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    controller = new AnalyticsController(
      mockAnalyticsService as any,
      mockPrisma as any,
    );
  });

  describe('track()', () => {
    it('should extract IP and fire-and-forget track call', () => {
      const mockReq = {
        headers: { 'user-agent': 'Mozilla/5.0' },
        socket: { remoteAddress: '1.2.3.4' },
        ip: '1.2.3.4',
      };

      const result = controller.track(
        mockReq as any,
        { event: 'page_view' } as any,
      );

      expect(result).toEqual({ ok: true });
      expect(mockAnalyticsService.track).toHaveBeenCalled();
    });

    it('should extract CF-Connecting-IP header first', () => {
      const mockReq = {
        headers: {
          'cf-connecting-ip': '8.8.8.8',
          'x-forwarded-for': '10.0.0.1',
          'user-agent': '',
        },
        socket: { remoteAddress: '127.0.0.1' },
        ip: '127.0.0.1',
      };

      controller.track(mockReq as any, {} as any);

      const ip = mockAnalyticsService.track.mock.calls[0][0];
      expect(ip).toBe('8.8.8.8');
    });

    it('should extract country hint from cf-ipcountry', () => {
      const mockReq = {
        headers: {
          'cf-ipcountry': 'DE',
          'user-agent': '',
        },
        socket: { remoteAddress: '1.2.3.4' },
        ip: '1.2.3.4',
      };

      controller.track(mockReq as any, {} as any);

      const countryHint = mockAnalyticsService.track.mock.calls[0][3];
      expect(countryHint).toBe('DE');
    });

    it('should have @Throttle on track method', () => {
      const track = AnalyticsController.prototype.track;
      const shortLimit = Reflect.getMetadata('THROTTLER:LIMITshort', track);
      expect(shortLimit).toBe(300);
    });

    it('should prefer x-real-ip over x-forwarded-for', () => {
      const mockReq = {
        headers: {
          'x-real-ip': '9.9.9.9',
          'x-forwarded-for': '10.0.0.1, 8.8.8.8',
          'user-agent': '',
        },
        socket: { remoteAddress: '127.0.0.1' },
        ip: '127.0.0.1',
      };

      controller.track(mockReq as any, {} as any);
      expect(mockAnalyticsService.track.mock.calls[0][0]).toBe('9.9.9.9');
    });

    it('should extract best public IP from x-forwarded-for chain', () => {
      const mockReq = {
        headers: {
          // Private IP first, then public — should pick the public one
          'x-forwarded-for': '10.0.0.1, 203.0.113.50, 192.168.1.1',
          'user-agent': '',
        },
        socket: { remoteAddress: '127.0.0.1' },
        ip: '127.0.0.1',
      };

      controller.track(mockReq as any, {} as any);
      expect(mockAnalyticsService.track.mock.calls[0][0]).toBe('203.0.113.50');
    });

    it('should parse RFC 7239 Forwarded header', () => {
      const mockReq = {
        headers: {
          forwarded: 'for=203.0.113.10;proto=https, for="[2001:db8::1]"',
          'user-agent': '',
        },
        socket: { remoteAddress: '127.0.0.1' },
        ip: '127.0.0.1',
      };

      controller.track(mockReq as any, {} as any);
      // Should pick 203.0.113.10 (first public IP from Forwarded header)
      expect(mockAnalyticsService.track.mock.calls[0][0]).toBe('203.0.113.10');
    });

    it('should fallback to socket.remoteAddress when no proxy headers', () => {
      const mockReq = {
        headers: { 'user-agent': '' },
        socket: { remoteAddress: '5.6.7.8' },
        ip: '5.6.7.8',
      };

      controller.track(mockReq as any, {} as any);
      expect(mockAnalyticsService.track.mock.calls[0][0]).toBe('5.6.7.8');
    });

    it('should skip "unknown" entries in x-forwarded-for', () => {
      const mockReq = {
        headers: {
          'x-forwarded-for': 'unknown, 203.0.113.99',
          'user-agent': '',
        },
        socket: { remoteAddress: '127.0.0.1' },
        ip: '127.0.0.1',
      };

      controller.track(mockReq as any, {} as any);
      expect(mockAnalyticsService.track.mock.calls[0][0]).toBe('203.0.113.99');
    });

    it('should extract country hint from x-vercel-ip-country', () => {
      const mockReq = {
        headers: {
          'x-vercel-ip-country': 'FR',
          'user-agent': '',
        },
        socket: { remoteAddress: '1.2.3.4' },
        ip: '1.2.3.4',
      };

      controller.track(mockReq as any, {} as any);
      expect(mockAnalyticsService.track.mock.calls[0][3]).toBe('FR');
    });

    it('should extract country hint from cloudfront-viewer-country', () => {
      const mockReq = {
        headers: {
          'cloudfront-viewer-country': 'JP',
          'user-agent': '',
        },
        socket: { remoteAddress: '1.2.3.4' },
        ip: '1.2.3.4',
      };

      controller.track(mockReq as any, {} as any);
      expect(mockAnalyticsService.track.mock.calls[0][3]).toBe('JP');
    });

    it('should ignore invalid country hint (non-2-letter)', () => {
      const mockReq = {
        headers: {
          'cf-ipcountry': 'XX1',
          'user-agent': '',
        },
        socket: { remoteAddress: '1.2.3.4' },
        ip: '1.2.3.4',
      };

      controller.track(mockReq as any, {} as any);
      expect(mockAnalyticsService.track.mock.calls[0][3]).toBeUndefined();
    });

    it('should handle true-client-ip header', () => {
      const mockReq = {
        headers: {
          'true-client-ip': '100.200.100.200',
          'user-agent': '',
        },
        socket: { remoteAddress: '127.0.0.1' },
        ip: '127.0.0.1',
      };

      controller.track(mockReq as any, {} as any);
      expect(mockAnalyticsService.track.mock.calls[0][0]).toBe(
        '100.200.100.200',
      );
    });

    it('should handle fastly-client-ip header', () => {
      const mockReq = {
        headers: {
          'fastly-client-ip': '50.60.70.80',
          'user-agent': '',
        },
        socket: { remoteAddress: '127.0.0.1' },
        ip: '127.0.0.1',
      };

      controller.track(mockReq as any, {} as any);
      expect(mockAnalyticsService.track.mock.calls[0][0]).toBe('50.60.70.80');
    });
  });

  describe('stats()', () => {
    it('should require AnalyticsGuard', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AnalyticsController.prototype.stats,
      );
      expect(guards).toContain(AnalyticsGuard);
    });

    it('should return ok with data', async () => {
      const result = await controller.stats('2026-03-01', '2026-03-19');
      expect(result.ok).toBe(true);
      expect(mockPrisma.user.count).toHaveBeenCalled();
    });

    it('should return error when getStats returns null', async () => {
      mockAnalyticsService.getStats.mockResolvedValue(null);

      const result = await controller.stats('invalid', '2026-03-19');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  describe('health()', () => {
    it('should require AnalyticsGuard', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AnalyticsController.prototype.health,
      );
      expect(guards).toContain(AnalyticsGuard);
    });

    it('should return health details with rollup status', async () => {
      const result = await controller.health();
      expect(result.enabled).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.connected).toBe(true);
      expect(result.rollup).toEqual({
        lastSuccessDate: '2026-03-23',
        stale: false,
      });
    });

    it('should return stale rollup when no last success', async () => {
      mockAnalyticsService.getRollupHealth.mockResolvedValue({
        lastSuccessDate: null,
        stale: true,
      });
      const result = await controller.health();
      expect(result.rollup).toEqual({ lastSuccessDate: null, stale: true });
    });
  });

  describe('realtime()', () => {
    it('should require AnalyticsGuard', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AnalyticsController.prototype.realtime,
      );
      expect(guards).toContain(AnalyticsGuard);
    });

    it('should return active session count', async () => {
      const result = await controller.realtime();
      expect(result.ok).toBe(true);
      expect(result.activeNow).toBe(5);
    });
  });

  describe('events()', () => {
    it('should require AnalyticsGuard', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AnalyticsController.prototype.events,
      );
      expect(guards).toContain(AnalyticsGuard);
    });

    it('should return ok with event aggregation data', async () => {
      const result = await controller.events('2026-03-01', '2026-03-30');
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.total).toBe(0);
      expect(mockAnalyticsService.getEventAggregation).toHaveBeenCalledWith(
        '2026-03-01',
        '2026-03-30',
        undefined,
      );
    });

    it('should pass eventType filter when provided', async () => {
      await controller.events('2026-03-01', '2026-03-30', 'page_view');
      expect(mockAnalyticsService.getEventAggregation).toHaveBeenCalledWith(
        '2026-03-01',
        '2026-03-30',
        'page_view',
      );
    });

    it('should default to 30-day range when from/to not provided', async () => {
      await controller.events(undefined as any, undefined as any);
      const [fromArg, toArg] = mockAnalyticsService.getEventAggregation.mock.calls[0];
      // from should be ~30 days ago, to should be today
      expect(fromArg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(toArg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should return generic error and log actual error on failure', async () => {
      const dbError = new Error('connection lost');
      mockAnalyticsService.getEventAggregation.mockRejectedValue(dbError);
      const logSpy = jest.spyOn(controller['logger'], 'error').mockImplementation();

      const result = await controller.events('2026-03-01', '2026-03-30');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Failed to fetch event aggregation');
      expect(result.error).not.toContain('connection lost');
      expect(logSpy).toHaveBeenCalledWith(
        'Failed to fetch event aggregation',
        dbError.stack,
      );
      logSpy.mockRestore();
    });
  });

  describe('latestMembers()', () => {
    it('should require AnalyticsGuard', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AnalyticsController.prototype.latestMembers,
      );
      expect(guards).toContain(AnalyticsGuard);
    });

    it('should return members from DB', async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'u1', name: 'Alice', username: 'alice', createdAt: new Date() },
      ]);

      const result = await controller.latestMembers('5');
      expect(result.ok).toBe(true);
      expect(result.members).toHaveLength(1);
      expect(result.members![0].name).toBe('Alice');
    });

    it('should clamp limit to max 20', async () => {
      await controller.latestMembers('100');
      const call = mockPrisma.user.findMany.mock.calls[0][0];
      expect(call.take).toBe(20);
    });

    it('should return generic error message and log actual error on failure', async () => {
      const dbError = new Error('connection refused to database');
      mockPrisma.user.findMany.mockRejectedValue(dbError);
      const logSpy = jest.spyOn(controller['logger'], 'error').mockImplementation();

      const result = await controller.latestMembers('5');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Failed to fetch latest members');
      // Must not leak the actual DB error message
      expect(result.error).not.toContain('connection refused');
      expect(logSpy).toHaveBeenCalledWith(
        'Failed to fetch latest members',
        dbError.stack,
      );

      logSpy.mockRestore();
    });
  });
});
