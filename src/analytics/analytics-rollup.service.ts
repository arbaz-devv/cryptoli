import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const KEY_PREFIX = 'analytics';
const ROLLUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 10_000; // 10s delay before first check
const NX_LOCK_TTL = 172_800; // 48 hours in seconds
const BACKFILL_DAYS = 7;

export interface DaySnapshot {
  pageviews: number;
  uniques: number;
  sessions: number;
  bounces: number;
  likes: number;
  durationSum: number;
  durationCount: number;
  byCountry: Record<string, number>;
  byDevice: Record<string, number>;
  byBrowser: Record<string, number>;
  byOs: Record<string, number>;
  byReferrer: Record<string, number>;
  byUtmSource: Record<string, number>;
  byUtmMedium: Record<string, number>;
  byUtmCampaign: Record<string, number>;
  byHour: Record<string, number>;
  byWeekday: Record<string, number>;
  byPath: Record<string, number>;
  byHourTz: Record<string, number>;
  durationHistogram: Record<string, number>;
  funnelEvents: Record<string, number>;
  funnelBySource: Record<string, number>;
  funnelByPath: Record<string, number>;
}

@Injectable()
export class AnalyticsRollupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsRollupService.name);
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private isFirstRun = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  private get redis() {
    return this.redisService.getClient();
  }

  onModuleInit(): void {
    this.initialTimer = setTimeout(() => {
      void this.checkAndRollup();
      this.initialTimer = null;
    }, INITIAL_DELAY_MS);

    this.timer = setInterval(() => {
      void this.checkAndRollup();
    }, ROLLUP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  /**
   * Read all analytics keys for a single day from Redis.
   * Returns a DaySnapshot with the same data that getStats() reads per-day.
   */
  async readDayFromRedis(day: string): Promise<DaySnapshot> {
    const redis = this.redis;
    if (!redis || !this.redisService.isReady()) {
      return this.emptySnapshot();
    }

    const [
      pv,
      countries,
      devices,
      browsers,
      oss,
      referrers,
      utmSources,
      utmMediums,
      utmCampaigns,
      hours,
      weekdays,
      paths,
      bounces,
      durationHist,
      durationSumDay,
      durationCountDay,
      funnelEvents,
      funnelBySourceDay,
      funnelByPathDay,
      uniquesDay,
      sessionsDay,
      likeDay,
      hourTzDay,
    ] = await Promise.all([
      redis.get(`${KEY_PREFIX}:pageviews:${day}`),
      redis.hgetall(`${KEY_PREFIX}:country:${day}`),
      redis.hgetall(`${KEY_PREFIX}:device:${day}`),
      redis.hgetall(`${KEY_PREFIX}:browser:${day}`),
      redis.hgetall(`${KEY_PREFIX}:os:${day}`),
      redis.hgetall(`${KEY_PREFIX}:referrer:${day}`),
      redis.hgetall(`${KEY_PREFIX}:utm_source:${day}`),
      redis.hgetall(`${KEY_PREFIX}:utm_medium:${day}`),
      redis.hgetall(`${KEY_PREFIX}:utm_campaign:${day}`),
      redis.hgetall(`${KEY_PREFIX}:hour:${day}`),
      redis.hgetall(`${KEY_PREFIX}:weekday:${day}`),
      redis.hgetall(`${KEY_PREFIX}:path:${day}`),
      redis.get(`${KEY_PREFIX}:bounces:${day}`),
      redis.hgetall(`${KEY_PREFIX}:duration_hist:${day}`),
      redis.get(`${KEY_PREFIX}:duration_sum:${day}`),
      redis.get(`${KEY_PREFIX}:duration_count:${day}`),
      redis.hgetall(`${KEY_PREFIX}:funnel:event:${day}`),
      redis.hgetall(`${KEY_PREFIX}:funnel:source:${day}`),
      redis.hgetall(`${KEY_PREFIX}:funnel:path:${day}`),
      redis.pfcount(`${KEY_PREFIX}:hll:uniques:${day}`),
      redis.pfcount(`${KEY_PREFIX}:hll:sessions:${day}`),
      redis.get(`${KEY_PREFIX}:like:${day}`),
      redis.hgetall(`${KEY_PREFIX}:hour_tz:${day}`),
    ]);

    const parseHash = (
      h: Record<string, string> | null,
    ): Record<string, number> => {
      const result: Record<string, number> = {};
      for (const [k, v] of Object.entries(h || {})) {
        result[k] = parseInt(v, 10) || 0;
      }
      return result;
    };

    return {
      pageviews: parseInt(pv || '0', 10),
      uniques: uniquesDay || 0,
      sessions: sessionsDay || 0,
      bounces: parseInt(bounces || '0', 10),
      likes: parseInt(likeDay || '0', 10),
      durationSum: parseInt(durationSumDay || '0', 10),
      durationCount: parseInt(durationCountDay || '0', 10),
      byCountry: parseHash(countries),
      byDevice: parseHash(devices),
      byBrowser: parseHash(browsers),
      byOs: parseHash(oss),
      byReferrer: parseHash(referrers),
      byUtmSource: parseHash(utmSources),
      byUtmMedium: parseHash(utmMediums),
      byUtmCampaign: parseHash(utmCampaigns),
      byHour: parseHash(hours),
      byWeekday: parseHash(weekdays),
      byPath: parseHash(paths),
      byHourTz: parseHash(hourTzDay),
      durationHistogram: parseHash(durationHist),
      funnelEvents: parseHash(funnelEvents),
      funnelBySource: parseHash(funnelBySourceDay),
      funnelByPath: parseHash(funnelByPathDay),
    };
  }

  /**
   * Idempotent rollup of a single day from Redis to PostgreSQL.
   * Returns true if the day was rolled up, false if skipped.
   *
   * Ordering:
   * 1. Check Redis NX lock (fast-path skip)
   * 2. Check PG (primary idempotency guard)
   * 3. Read Redis snapshot
   * 4. Validate non-zero pageviews
   * 5. Write to PG via createMany
   * 6. Set Redis NX lock (after PG write, not before — crash safety)
   */
  async rollupDay(day: string): Promise<boolean> {
    const redis = this.redis;

    // Fast-path: check Redis NX lock
    if (redis && this.redisService.isReady()) {
      const lock = await redis.get(`${KEY_PREFIX}:rollup:last:${day}`);
      if (lock) {
        this.logger.debug(`Rollup skipped (NX lock): ${day}`);
        return false;
      }
    }

    // Primary idempotency guard: check PG
    const existing = await this.prisma.analyticsDailySummary.findFirst({
      where: {
        date: new Date(`${day}T00:00:00Z`),
        dimension: '_total_',
      },
    });
    if (existing) {
      this.logger.debug(`Rollup skipped (PG exists): ${day}`);
      return false;
    }

    // Read snapshot from Redis
    const snapshot = await this.readDayFromRedis(day);

    // Validate non-zero — skip if Redis was down or keys expired
    if (snapshot.pageviews <= 0) {
      this.logger.debug(`Rollup skipped (zero pageviews): ${day}`);
      return false;
    }

    // Build rows for createMany
    const dateVal = new Date(`${day}T00:00:00Z`);
    const rows = this.snapshotToRows(snapshot, dateVal);

    // Write to PG
    try {
      await this.prisma.analyticsDailySummary.createMany({
        data: rows,
        skipDuplicates: true, // Belt-and-suspenders with unique constraint
      });
    } catch (error) {
      // Unique constraint violation = concurrent rollup, treat as success
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        this.logger.warn(`Rollup concurrent duplicate caught: ${day}`);
      } else {
        throw error;
      }
    }

    // Set NX lock AFTER successful PG write
    if (redis && this.redisService.isReady()) {
      await redis.set(
        `${KEY_PREFIX}:rollup:last:${day}`,
        '1',
        'EX',
        NX_LOCK_TTL,
        'NX',
      );
    }

    this.logger.log(`Rollup complete: ${day}`);
    return true;
  }

  /**
   * Hourly check: roll up yesterday + day-before-yesterday.
   * On first run (startup), backfills up to 7 days.
   */
  private async checkAndRollup(): Promise<void> {
    const daysToCheck = this.isFirstRun ? BACKFILL_DAYS : 2;
    this.isFirstRun = false;

    const now = new Date();
    for (let i = 1; i <= daysToCheck; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const day = d.toISOString().slice(0, 10);

      try {
        const rolledUp = await this.rollupDay(day);
        if (rolledUp) {
          // Record last success date
          const redis = this.redis;
          if (redis && this.redisService.isReady()) {
            await redis.set(`${KEY_PREFIX}:rollup:last_success`, day);
          }
        }
      } catch (error) {
        this.logger.error(
          `Rollup failed for ${day}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Convert a DaySnapshot into EAV rows for AnalyticsDailySummary.
   */
  private snapshotToRows(
    snapshot: DaySnapshot,
    date: Date,
  ): Array<{
    date: Date;
    dimension: string;
    dimensionValue: string;
    count: number;
  }> {
    const rows: Array<{
      date: Date;
      dimension: string;
      dimensionValue: string;
      count: number;
    }> = [];

    const addScalar = (name: string, value: number) => {
      if (value !== 0) {
        rows.push({
          date,
          dimension: '_total_',
          dimensionValue: name,
          count: value,
        });
      }
    };

    const addHash = (dimension: string, hash: Record<string, number>) => {
      for (const [key, value] of Object.entries(hash)) {
        if (value !== 0) {
          rows.push({
            date,
            dimension,
            dimensionValue: key.slice(0, 128),
            count: value,
          });
        }
      }
    };

    // Scalars
    addScalar('pageviews', snapshot.pageviews);
    addScalar('uniques_approx', snapshot.uniques);
    addScalar('sessions_approx', snapshot.sessions);
    addScalar('bounces', snapshot.bounces);
    addScalar('likes', snapshot.likes);
    addScalar('duration_sum', snapshot.durationSum);
    addScalar('duration_count', snapshot.durationCount);

    // Hash dimensions
    addHash('country', snapshot.byCountry);
    addHash('device', snapshot.byDevice);
    addHash('browser', snapshot.byBrowser);
    addHash('os', snapshot.byOs);
    addHash('referrer', snapshot.byReferrer);
    addHash('utm_source', snapshot.byUtmSource);
    addHash('utm_medium', snapshot.byUtmMedium);
    addHash('utm_campaign', snapshot.byUtmCampaign);
    addHash('hour', snapshot.byHour);
    addHash('weekday', snapshot.byWeekday);
    addHash('path', snapshot.byPath);
    addHash('hour_tz', snapshot.byHourTz);
    addHash('duration_bucket', snapshot.durationHistogram);
    addHash('funnel_event', snapshot.funnelEvents);
    addHash('funnel_by_source', snapshot.funnelBySource);
    addHash('funnel_by_path', snapshot.funnelByPath);

    return rows;
  }

  private emptySnapshot(): DaySnapshot {
    return {
      pageviews: 0,
      uniques: 0,
      sessions: 0,
      bounces: 0,
      likes: 0,
      durationSum: 0,
      durationCount: 0,
      byCountry: {},
      byDevice: {},
      byBrowser: {},
      byOs: {},
      byReferrer: {},
      byUtmSource: {},
      byUtmMedium: {},
      byUtmCampaign: {},
      byHour: {},
      byWeekday: {},
      byPath: {},
      byHourTz: {},
      durationHistogram: {},
      funnelEvents: {},
      funnelBySource: {},
      funnelByPath: {},
    };
  }
}
