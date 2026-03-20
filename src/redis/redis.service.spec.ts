import { RedisService } from './redis.service';

// Mock ioredis so we don't create real connections
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => {
    const handlers: Record<string, Function> = {};
    return {
      on: jest.fn((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
      quit: jest.fn().mockResolvedValue('OK'),
      _handlers: handlers,
      _fireReady: function () {
        handlers['ready']?.();
      },
      _fireError: function (err: Error) {
        handlers['error']?.(err);
      },
      _fireEnd: function () {
        handlers['end']?.();
      },
    };
  });
});

describe('RedisService', () => {
  const originalEnv = { ...process.env };
  let service: RedisService;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.REDIS_URL;
    service = new RedisService();
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  describe('when REDIS_URL is not set', () => {
    it('should not create client', () => {
      service.onModuleInit();
      expect(service.getClient()).toBeNull();
      expect(service.isReady()).toBe(false);
      expect(service.getLastError()).toBe('REDIS_URL is not set');
    });
  });

  describe('when REDIS_URL is set', () => {
    beforeEach(() => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      service.onModuleInit();
    });

    it('should create client', () => {
      expect(service.getClient()).not.toBeNull();
    });

    it('should not be ready before ready event', () => {
      expect(service.isReady()).toBe(false);
    });

    it('should become ready on ready event', () => {
      const client = service.getClient() as any;
      client._fireReady();
      expect(service.isReady()).toBe(true);
      expect(service.getLastError()).toBeNull();
    });

    it('should handle error event', () => {
      const client = service.getClient() as any;
      client._fireError(new Error('connection refused'));
      expect(service.isReady()).toBe(false);
      expect(service.getLastError()).toBe('connection refused');
    });

    it('should handle end event', () => {
      const client = service.getClient() as any;
      client._fireReady();
      client._fireEnd();
      expect(service.isReady()).toBe(false);
    });
  });

  describe('onModuleDestroy', () => {
    it('should quit client and clear state', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      service.onModuleInit();
      const client = service.getClient() as any;
      client._fireReady();

      await service.onModuleDestroy();

      expect(client.quit).toHaveBeenCalled();
      expect(service.getClient()).toBeNull();
      expect(service.isReady()).toBe(false);
    });

    it('should no-op when no client', async () => {
      service.onModuleInit(); // no REDIS_URL
      await service.onModuleDestroy(); // should not throw
    });
  });

  describe('setLastError', () => {
    it('should set and get last error', () => {
      service.setLastError('custom error');
      expect(service.getLastError()).toBe('custom error');
      service.setLastError(null);
      expect(service.getLastError()).toBeNull();
    });
  });
});
