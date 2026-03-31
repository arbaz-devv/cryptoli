import { Controller, Get } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ObservabilityService } from './observability.service';

@Controller('api/health')
export class ObservabilityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly observability: ObservabilityService,
  ) {}

  @Get('live')
  live() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSec: this.observability.getSnapshot().uptimeSec,
    };
  }

  @Get('ready')
  async ready() {
    const startedAt = Date.now();

    const redisClient = this.redisService.getClient();
    const redisConfigured = Boolean(process.env.REDIS_URL?.trim());

    const databasePromise = (async () => {
      try {
        const dbStartedAt = Date.now();
        await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
        return {
          ready: true,
          latencyMs: Date.now() - dbStartedAt,
          error: null as string | null,
        };
      } catch (error) {
        return {
          ready: false,
          latencyMs: 0,
          error:
            error instanceof Error ? error.message : 'Database unavailable',
        };
      }
    })();

    const redisPromise = (async () => {
      if (!redisConfigured || !redisClient || !this.redisService.isReady()) {
        return {
          configured: redisConfigured,
          ready: false,
          latencyMs: 0,
          error: this.redisService.getLastError(),
        };
      }

      try {
        const redisStartedAt = Date.now();
        await redisClient.ping();
        return {
          configured: true,
          ready: true,
          latencyMs: Date.now() - redisStartedAt,
          error: null as string | null,
        };
      } catch (error) {
        return {
          configured: true,
          ready: false,
          latencyMs: 0,
          error: error instanceof Error ? error.message : 'Redis unavailable',
        };
      }
    })();

    const [database, redis] = await Promise.all([
      databasePromise,
      redisPromise,
    ]);

    const ready = database.ready && (!redis.configured || redis.ready);

    return {
      ready,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      checks: {
        database,
        redis,
      },
    };
  }
}
