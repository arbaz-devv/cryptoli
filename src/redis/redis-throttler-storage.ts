import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from './redis.service';

/**
 * Lua script for atomic throttle increment with block support.
 *
 * KEYS[1] = throttle key (hits counter)
 * KEYS[2] = block key
 * ARGV[1] = TTL in milliseconds
 * ARGV[2] = limit
 * ARGV[3] = block duration in milliseconds
 *
 * Returns: [totalHits, timeToExpire, isBlocked, timeToBlockExpire]
 */
const LUA_INCREMENT = `
local blockedTTL = redis.call('PTTL', KEYS[2])
if blockedTTL > 0 then
  return {0, 0, 1, blockedTTL}
end

local totalHits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -1 or ttl == -2 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end

if totalHits > tonumber(ARGV[2]) then
  local blockDuration = tonumber(ARGV[3])
  if blockDuration > 0 then
    redis.call('SET', KEYS[2], '1', 'PX', blockDuration)
    return {totalHits, ttl, 1, blockDuration}
  end
end

return {totalHits, ttl, 0, 0}
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const client = this.redis.getClient();

    if (!client || !this.redis.isReady()) {
      // Fail open: no rate limiting when Redis is unavailable
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }

    try {
      const hitKey = `throttle:${throttlerName}:${key}`;
      const blockKey = `throttle:${throttlerName}:${key}:blocked`;

      const result = (await client.eval(
        LUA_INCREMENT,
        2,
        hitKey,
        blockKey,
        ttl,
        limit,
        blockDuration,
      )) as number[];

      return {
        totalHits: result[0],
        timeToExpire: result[1],
        isBlocked: result[2] === 1,
        timeToBlockExpire: result[3],
      };
    } catch {
      // Fail open on Redis errors
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
