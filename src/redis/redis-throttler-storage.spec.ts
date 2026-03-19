import { RedisThrottlerStorage } from './redis-throttler-storage';
import { RedisService } from './redis.service';

function mockRedisService(overrides: Partial<RedisService> = {}): RedisService {
  return {
    getClient: jest.fn().mockReturnValue(null),
    isReady: jest.fn().mockReturnValue(false),
    getLastError: jest.fn().mockReturnValue(null),
    setLastError: jest.fn(),
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    ...overrides,
  } as unknown as RedisService;
}

describe('RedisThrottlerStorage', () => {
  describe('when Redis is unavailable', () => {
    it('should fail open with totalHits 0 when client is null', async () => {
      const redis = mockRedisService();
      const storage = new RedisThrottlerStorage(redis);

      const result = await storage.increment(
        'test-key',
        60_000,
        10,
        0,
        'short',
      );

      expect(result).toEqual({
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it('should fail open when Redis is not ready', async () => {
      const mockClient = { eval: jest.fn() };
      const redis = mockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
        isReady: jest.fn().mockReturnValue(false),
      });
      const storage = new RedisThrottlerStorage(redis);

      const result = await storage.increment(
        'test-key',
        60_000,
        10,
        0,
        'short',
      );

      expect(result.totalHits).toBe(0);
      expect(mockClient.eval).not.toHaveBeenCalled();
    });
  });

  describe('when Redis is available', () => {
    it('should return hit count from Lua script', async () => {
      const mockClient = {
        eval: jest.fn().mockResolvedValue([3, 58000, 0, 0]),
      };
      const redis = mockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
        isReady: jest.fn().mockReturnValue(true),
      });
      const storage = new RedisThrottlerStorage(redis);

      const result = await storage.increment(
        'user:123',
        60_000,
        10,
        0,
        'short',
      );

      expect(result).toEqual({
        totalHits: 3,
        timeToExpire: 58000,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
      expect(mockClient.eval).toHaveBeenCalledWith(
        expect.any(String),
        2,
        'throttle:short:user:123',
        'throttle:short:user:123:blocked',
        60_000,
        10,
        0,
      );
    });

    it('should report blocked status when Lua returns blocked', async () => {
      const mockClient = {
        eval: jest.fn().mockResolvedValue([11, 60000, 1, 30000]),
      };
      const redis = mockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
        isReady: jest.fn().mockReturnValue(true),
      });
      const storage = new RedisThrottlerStorage(redis);

      const result = await storage.increment(
        'user:456',
        60_000,
        10,
        30_000,
        'long',
      );

      expect(result.isBlocked).toBe(true);
      expect(result.timeToBlockExpire).toBe(30000);
    });

    it('should fail open when Lua script throws', async () => {
      const mockClient = {
        eval: jest.fn().mockRejectedValue(new Error('READONLY')),
      };
      const redis = mockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
        isReady: jest.fn().mockReturnValue(true),
      });
      const storage = new RedisThrottlerStorage(redis);

      const result = await storage.increment(
        'test-key',
        60_000,
        10,
        0,
        'short',
      );

      expect(result.totalHits).toBe(0);
      expect(result.isBlocked).toBe(false);
    });
  });
});
