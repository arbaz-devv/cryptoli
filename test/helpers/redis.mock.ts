/**
 * Shared RedisService mock for unit tests.
 * Defaults to not-ready state. Pass `ready = true` to simulate connected Redis.
 */
export function createRedisMock(ready = false) {
  const clientMock = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn(),
    setex: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    ttl: jest.fn(),
    keys: jest.fn().mockResolvedValue([]),
    mget: jest.fn().mockResolvedValue([]),
    pipeline: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue([]),
    }),
    multi: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue([]),
    }),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn(),
    sadd: jest.fn(),
    smembers: jest.fn().mockResolvedValue([]),
    srem: jest.fn(),
    hset: jest.fn(),
    hget: jest.fn(),
    hgetall: jest.fn().mockResolvedValue({}),
    hincrby: jest.fn(),
    pfadd: jest.fn(),
    pfcount: jest.fn().mockResolvedValue(0),
    incrby: jest.fn(),
    zadd: jest.fn(),
    zrangebyscore: jest.fn().mockResolvedValue([]),
    zremrangebyscore: jest.fn(),
    zcard: jest.fn().mockResolvedValue(0),
    eval: jest.fn(),
  };

  return {
    isReady: jest.fn().mockReturnValue(ready),
    getClient: jest.fn().mockReturnValue(ready ? clientMock : null),
    getLastError: jest.fn().mockReturnValue(null),
    setLastError: jest.fn(),
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    _clientMock: clientMock,
  };
}
