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
    };
    mockPrisma = {
      user: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
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

      const result = controller.track(mockReq as any, { event: 'page_view' } as any);

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
    it('should return health details', async () => {
      const result = await controller.health();
      expect(result.enabled).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.connected).toBe(true);
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
  });
});
