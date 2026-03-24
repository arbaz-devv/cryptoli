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
    pipeline: jest.fn().mockImplementation(() => {
      const pipe = {
        commands: [] as Array<{ cmd: string; args: unknown[] }>,
        incr(...args: unknown[]) {
          pipe.commands.push({ cmd: 'incr', args });
          return pipe;
        },
        incrby(...args: unknown[]) {
          pipe.commands.push({ cmd: 'incrby', args });
          return pipe;
        },
        hincrby(...args: unknown[]) {
          pipe.commands.push({ cmd: 'hincrby', args });
          return pipe;
        },
        pfadd(...args: unknown[]) {
          pipe.commands.push({ cmd: 'pfadd', args });
          return pipe;
        },
        zadd(...args: unknown[]) {
          pipe.commands.push({ cmd: 'zadd', args });
          return pipe;
        },
        sadd(...args: unknown[]) {
          pipe.commands.push({ cmd: 'sadd', args });
          return pipe;
        },
        set(...args: unknown[]) {
          pipe.commands.push({ cmd: 'set', args });
          return pipe;
        },
        expire(...args: unknown[]) {
          pipe.commands.push({ cmd: 'expire', args });
          return pipe;
        },
        zremrangebyscore(...args: unknown[]) {
          pipe.commands.push({ cmd: 'zremrangebyscore', args });
          return pipe;
        },
        hset(...args: unknown[]) {
          pipe.commands.push({ cmd: 'hset', args });
          return pipe;
        },
        hsetnx(...args: unknown[]) {
          pipe.commands.push({ cmd: 'hsetnx', args });
          return pipe;
        },
        exec: jest.fn().mockResolvedValue([]),
      };
      return pipe;
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
