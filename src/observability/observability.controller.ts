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

    let database = {
      ready: false,
      latencyMs: 0,
      error: null as string | null,
    };
    try {
      const dbStartedAt = Date.now();
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
      database = {
        ready: true,
        latencyMs: Date.now() - dbStartedAt,
        error: null,
      };
    } catch (error) {
      database = {
        ready: false,
        latencyMs: 0,
        error: error instanceof Error ? error.message : 'Database unavailable',
      };
    }

    const redisClient = this.redisService.getClient();
    let redis = {
      configured: Boolean(process.env.REDIS_URL?.trim()),
      ready: false,
      latencyMs: 0,
      error: this.redisService.getLastError(),
    };

    if (redis.configured && redisClient && this.redisService.isReady()) {
      try {
        const redisStartedAt = Date.now();
        await redisClient.ping();
        redis = {
          configured: true,
          ready: true,
          latencyMs: Date.now() - redisStartedAt,
          error: null,
        };
      } catch (error) {
        redis = {
          configured: true,
          ready: false,
          latencyMs: 0,
          error: error instanceof Error ? error.message : 'Redis unavailable',
        };
      }
    }

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
