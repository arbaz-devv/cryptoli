import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { AnalyticsBufferService } from './analytics-buffer.service';
import type { BufferedEvent } from './analytics-buffer.service';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import * as geoip from 'geoip-lite';
import { isBot } from 'ua-parser-js/bot-detection';
import { normalizeIp, isPrivateOrLocalIp } from './ip-utils';
import { getDeviceAndBrowser } from '../common/ua';

const KEY_PREFIX = 'analytics';
const KEY_RECENT_SESSIONS = `${KEY_PREFIX}:recent_sessions`;
const RECENT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const TTL_DAYS = 32;
const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;
const FUNNEL_EVENTS = [
  'signup_started',
  'signup_completed',
  'purchase',
] as const;
type FunnelEvent = (typeof FUNNEL_EVENTS)[number];
const LIKE_EVENT = 'like';
const DURATION_BUCKETS: Array<{ max: number; label: string }> = [
  { max: 9, label: '0_9' },
  { max: 29, label: '10_29' },
  { max: 59, label: '30_59' },
  { max: 119, label: '60_119' },
  { max: 299, label: '120_299' },
  { max: 599, label: '300_599' },
  { max: 1799, label: '600_1799' },
  { max: Number.POSITIVE_INFINITY, label: '1800_plus' },
];

/** Server-side event types emitted by feature modules (not from the frontend). */
export type ServerSideEvent =
  | 'review_created'
  | 'vote_cast'
  | 'comment_created'
  | 'complaint_created'
  | 'user_follow'
  | 'user_unfollow'
  | 'search_performed'
  | 'user_login'
  | 'user_register'
  | 'user_logout'
  | 'password_change';

export interface TrackPayload {
  path?: string;
  device?: string; // userAgent
  timezone?: string;
  event?: 'page_view' | 'page_leave' | FunnelEvent | 'like' | ServerSideEvent;
  sessionId?: string;
  userId?: string;
  enteredAt?: string; // ISO date
  leftAt?: string; // ISO date
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  /** When false, do not store (user declined cookies). When true or omitted, store. */
  consent?: boolean;
  /** Arbitrary properties for server-side events (stored in PG only). */
  properties?: Record<string, unknown>;
}

export interface TimeSeriesPoint {
  date: string;
  pageviews: number;
  uniques: number;
}

export interface AnalyticsStats {
  totalPageviews: number;
  totalUniques: number;
  totalSessions: number;
  activeToday: number;
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
  /** Visitor timezone–based hour distribution (when timezone is sent). Keys 0–23. */
  byHourTz?: Record<string, number>;
  topPages: { path: string; pageviews: number }[];
  avgDurationSeconds: number;
  durationP50Seconds: number;
  durationP95Seconds: number;
  totalBounces: number;
  bounceRate: number; // 0-100
  timeSeries: TimeSeriesPoint[];
  dateRange: { from: string; to: string };
  /** Optional: total likes (e.g. from Redis or DB). Omit or 0 if not tracked. */
  likes?: number;
  /** Optional: total sales in range. Omit or 0 if not tracked. */
  sales?: number;
  /** Optional: new signups in date range. Omit or 0 if not tracked. */
  newMembersInRange?: number;
  funnel?: {
    signup_started: number;
    signup_completed: number;
    purchase: number;
    signupCompletionRate: number;
    purchaseRate: number;
  };
  funnelByUtmSource?: Array<{
    utmSource: string;
    signup_started: number;
    signup_completed: number;
    purchase: number;
  }>;
  funnelByPath?: Array<{
    path: string;
    signup_started: number;
    signup_completed: number;
    purchase: number;
  }>;
  /** Retention rate (0–100): % of new visitors who return on Day 1, 7, 30. Only from consented activity. */
  retention?: {
    day1Pct: number;
    day7Pct: number;
    day30Pct: number;
    cohortDays: number;
  };
}

export const dynamic = 'force-dynamic';

const STATS_CACHE_TTL_MS = 60 * 1000; // 1 minute
const statsCache = new Map<string, { data: AnalyticsStats; expiry: number }>();

/** Days older than this are read from PG (4-day buffer vs 32-day Redis TTL). */
const PG_CUTOFF_DAYS = 28;

/**
 * Accumulator shape returned by readDayRangeFromPg().
 * Mirrors the variables accumulated in the Redis day loop of getStats().
 */
export interface PgPartialStats {
  totalPageviews: number;
  totalBounces: number;
  durationSum: number;
  durationCount: number;
  totalLikes: number;
  /** Sum of per-day PFCOUNT snapshots (approximate, may overcount 3-20%). */
  totalUniques: number;
  totalSessions: number;
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
  pathCounts: Record<string, number>;
  byHourTz: Record<string, number>;
  durationHistogram: Record<string, number>;
  funnelEventCounts: Record<string, number>;
  funnelBySourceRaw: Record<string, number>;
  funnelByPathRaw: Record<string, number>;
  timeSeries: TimeSeriesPoint[];
}

const RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const ANONYMIZE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour (daily guard in Redis)
const ANONYMIZE_RETENTION_DAYS = 90;
const ANONYMIZE_BATCH_THRESHOLD = 200_000;

@Injectable()
export class AnalyticsService implements OnModuleInit, OnModuleDestroy {
  private retentionTimer: NodeJS.Timeout | null = null;
  private anonymizeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redisService: RedisService,
    @Optional()
    @Inject(forwardRef(() => AnalyticsBufferService))
    private readonly bufferService?: AnalyticsBufferService,
    @Optional()
    private readonly prisma?: PrismaService,
  ) {}

  onModuleInit(): void {
    this.retentionTimer = setInterval(() => {
      void this.computeRetention();
    }, RETENTION_INTERVAL_MS);
    this.anonymizeTimer = setInterval(() => {
      void this.anonymizeExpiredUsers();
    }, ANONYMIZE_CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.anonymizeTimer) {
      clearInterval(this.anonymizeTimer);
      this.anonymizeTimer = null;
    }
  }

  private get redis(): Redis | null {
    return this.redisService.getClient();
  }

  private dayKey(date: Date): string {
    return date.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private addDays(dateStr: string, n: number): string {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  private async incr(key: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.incr(key);
    await this.redis.expire(key, TTL_DAYS * 24 * 60 * 60);
  }

  private async hincrby(
    key: string,
    field: string,
    delta: number,
  ): Promise<void> {
    if (!this.redis) return;
    await this.redis.hincrby(key, field, delta);
    await this.redis.expire(key, TTL_DAYS * 24 * 60 * 60);
  }

  private async incrby(key: string, delta: number): Promise<void> {
    if (!this.redis) return;
    await this.redis.incrby(key, delta);
    await this.redis.expire(key, TTL_DAYS * 24 * 60 * 60);
  }

  private async hget(key: string, field: string): Promise<string | null> {
    if (!this.redis) return null;
    return this.redis.hget(key, field);
  }

  private async pfadd(key: string, ...members: string[]): Promise<void> {
    if (!this.redis) return;
    await this.redis.pfadd(key, ...members);
    await this.redis.expire(key, TTL_DAYS * 24 * 60 * 60);
  }

  private async pfcount(key: string): Promise<number> {
    if (!this.redis) return 0;
    return this.redis.pfcount(key);
  }

  private durationBucket(durationSec: number): string {
    for (const bucket of DURATION_BUCKETS) {
      if (durationSec <= bucket.max) return bucket.label;
    }
    return DURATION_BUCKETS[DURATION_BUCKETS.length - 1]?.label || '1800_plus';
  }

  private normalizeSessionId(raw?: string): string {
    const sessionId = (raw || '').trim();
    if (SESSION_ID_REGEX.test(sessionId)) return sessionId;
    return `anon_${Math.random().toString(36).slice(2, 12)}_${Date.now().toString(36)}`;
  }

  private normalizePath(rawPath?: string): string {
    const input = (rawPath || '/').trim() || '/';
    let pathname = input;
    try {
      const parsed = new URL(input, 'https://placeholder.local');
      pathname = parsed.pathname || '/';
    } catch {
      pathname = input.split('?')[0]?.split('#')[0] || '/';
    }
    const normalized = pathname
      .replace(/\/{2,}/g, '/')
      .split('/')
      .map((part) => {
        if (!part) return '';
        if (/^\d+$/.test(part)) return ':id';
        if (/^[0-9a-f]{8,}$/i.test(part)) return ':id';
        if (
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            part,
          )
        )
          return ':id';
        return part;
      })
      .join('/');
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  private sanitizeLabel(raw?: string, fallback = 'none'): string {
    const value = (raw || '').trim().toLowerCase();
    if (!value) return fallback;
    return value.replace(/[^a-z0-9._-]/g, '_').slice(0, 80) || fallback;
  }

  /** Add/update session in recent set for real-time "active now" (last 5 min). */
  private async addRecentSession(nowMs: number, member: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.zadd(KEY_RECENT_SESSIONS, nowMs, member);
      await this.redis.zremrangebyscore(
        KEY_RECENT_SESSIONS,
        '-inf',
        nowMs - RECENT_WINDOW_MS,
      );
      await this.redis.expire(
        KEY_RECENT_SESSIONS,
        Math.ceil(RECENT_WINDOW_MS / 1000) + 60,
      );
    } catch {
      // non-fatal
    }
  }

  private emptyStats(from: string, to: string): AnalyticsStats {
    return {
      totalPageviews: 0,
      totalUniques: 0,
      totalSessions: 0,
      activeToday: 0,
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
      topPages: [],
      avgDurationSeconds: 0,
      durationP50Seconds: 0,
      durationP95Seconds: 0,
      totalBounces: 0,
      bounceRate: 0,
      timeSeries: [],
      dateRange: { from, to },
      likes: 0,
      sales: 0,
      newMembersInRange: 0,
      funnel: {
        signup_started: 0,
        signup_completed: 0,
        purchase: 0,
        signupCompletionRate: 0,
        purchaseRate: 0,
      },
      funnelByUtmSource: [],
      funnelByPath: [],
    };
  }

  /**
   * Resolve country code for an IP:
   * 1) Try local geoip-lite database
   * 2) If unknown, optionally call external IP->country API
   * 3) Cache successful lookups in Redis to avoid repeated API calls
   */
  private isValidCountryCode(code?: string): boolean {
    return /^[A-Z]{2}$/.test((code || '').trim().toUpperCase());
  }

  private async resolveCountry(
    ip: string,
    countryHint?: string,
  ): Promise<string> {
    const hint = (countryHint || '').trim().toUpperCase();
    if (this.isValidCountryCode(hint)) return hint;

    const normalizedIp = normalizeIp(ip);
    if (!normalizedIp || isPrivateOrLocalIp(normalizedIp)) return 'unknown';

    const cacheKey = `${KEY_PREFIX}:ip_country:${normalizedIp}`;
    if (this.redis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) return cached;
      } catch {
        // ignore cache read errors, fall through
      }
    }

    // Use local geoip-lite only — no external API calls (GDPR)
    const { country } = this.getGeo(normalizedIp);
    const countryCode = (country || '').toUpperCase();

    if (!this.isValidCountryCode(countryCode)) return 'unknown';

    // Cache non-unknown results for 30 days
    if (this.redis && countryCode !== 'unknown') {
      try {
        await this.redis.set(cacheKey, countryCode, 'EX', 30 * 24 * 60 * 60);
      } catch {
        // ignore cache write errors
      }
    }

    return countryCode;
  }

  private getGeo(ip: string): {
    country?: string;
    city?: string;
    region?: string;
  } {
    const geo = geoip.lookup(ip);
    if (!geo) return {};
    return {
      country: geo.country || undefined,
      city: geo.city,
      region: geo.region,
    };
  }

  private hashIp(ip: string): string | undefined {
    if (!ip) return undefined;
    return createHash('sha256').update(ip).digest('hex');
  }

  private pushToBuffer(event: BufferedEvent): void {
    if (this.bufferService) {
      this.bufferService.push(event);
    }
  }

  private referrerLabel(referrer?: string): string {
    if (!referrer || !referrer.trim()) return 'direct';
    try {
      const u = new URL(referrer);
      const hostname = (u.hostname || '').toLowerCase().replace(/^www\./, '');
      return hostname || 'direct';
    } catch {
      return 'direct';
    }
  }

  /** Non-blocking: enqueue track and return immediately. Only store when consent is explicitly true (GDPR opt-in). */
  async track(
    ip: string,
    userAgent: string,
    body: TrackPayload,
    countryHint?: string,
  ): Promise<void> {
    if (!this.redisService.isReady() || !this.redis) return;
    if (!body.consent) return;
    if (userAgent && isBot(userAgent)) return;

    const now = new Date();
    const day = this.dayKey(now);
    const countryCode = await this.resolveCountry(ip, countryHint);
    const { device, browser, os } = getDeviceAndBrowser(
      userAgent || body.device || '',
    );
    const path = this.normalizePath(body.path);
    const sessionId = this.normalizeSessionId(body.sessionId);
    const referrer = this.referrerLabel(body.referrer);
    const utmSource = this.sanitizeLabel(body.utm_source, 'none');
    const utmMedium = this.sanitizeLabel(body.utm_medium, 'none');
    const utmCampaign = this.sanitizeLabel(body.utm_campaign, 'none');
    const hour = String(now.getHours());
    const weekday = String(now.getDay()); // 0-6
    const ttl = TTL_DAYS * 24 * 60 * 60;

    if (body.event === 'page_view' || !body.event) {
      const nowMs = now.getTime();
      const member = `${sessionId}:${countryCode}`;
      const cohortTtl = 35 * 24 * 60 * 60;
      const recentTtl = Math.ceil(RECENT_WINDOW_MS / 1000) + 60;

      const pipe = this.redis.pipeline();

      // Core pageview metrics
      pipe.incr(`${KEY_PREFIX}:pageviews:${day}`);
      pipe.expire(`${KEY_PREFIX}:pageviews:${day}`, ttl);
      pipe.pfadd(`${KEY_PREFIX}:hll:uniques:${day}`, sessionId);
      pipe.expire(`${KEY_PREFIX}:hll:uniques:${day}`, ttl);
      pipe.pfadd(`${KEY_PREFIX}:hll:sessions:${day}`, sessionId);
      pipe.expire(`${KEY_PREFIX}:hll:sessions:${day}`, ttl);

      // Dimensional breakdowns
      pipe.hincrby(`${KEY_PREFIX}:country:${day}`, countryCode, 1);
      pipe.expire(`${KEY_PREFIX}:country:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:device:${day}`, device, 1);
      pipe.expire(`${KEY_PREFIX}:device:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:browser:${day}`, browser, 1);
      pipe.expire(`${KEY_PREFIX}:browser:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:os:${day}`, os, 1);
      pipe.expire(`${KEY_PREFIX}:os:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:referrer:${day}`, referrer, 1);
      pipe.expire(`${KEY_PREFIX}:referrer:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:utm_source:${day}`, utmSource, 1);
      pipe.expire(`${KEY_PREFIX}:utm_source:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:utm_medium:${day}`, utmMedium, 1);
      pipe.expire(`${KEY_PREFIX}:utm_medium:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:utm_campaign:${day}`, utmCampaign, 1);
      pipe.expire(`${KEY_PREFIX}:utm_campaign:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:hour:${day}`, hour, 1);
      pipe.expire(`${KEY_PREFIX}:hour:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:weekday:${day}`, weekday, 1);
      pipe.expire(`${KEY_PREFIX}:weekday:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:path:${day}`, path, 1);
      pipe.expire(`${KEY_PREFIX}:path:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:session_pages:${day}`, sessionId, 1);
      pipe.expire(`${KEY_PREFIX}:session_pages:${day}`, ttl);

      // Recent sessions sorted set
      pipe.zadd(KEY_RECENT_SESSIONS, nowMs, member);
      pipe.zremrangebyscore(
        KEY_RECENT_SESSIONS,
        '-inf',
        nowMs - RECENT_WINDOW_MS,
      );
      pipe.expire(KEY_RECENT_SESSIONS, recentTtl);

      // Cohort tracking — per-day hash instead of per-session key (Fix 3: key scaling)
      pipe.hsetnx(`${KEY_PREFIX}:first_visit:${day}`, sessionId, '1');
      pipe.expire(`${KEY_PREFIX}:first_visit:${day}`, cohortTtl);
      // SADD is unconditional (idempotent)
      pipe.sadd(`${KEY_PREFIX}:cohort:${day}`, sessionId);
      pipe.expire(`${KEY_PREFIX}:cohort:${day}`, cohortTtl);

      // Timezone-adjusted hour
      if (
        body.timezone &&
        typeof body.timezone === 'string' &&
        body.timezone.trim()
      ) {
        try {
          const tz = body.timezone.trim();
          const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            hour: '2-digit',
            hour12: false,
          });
          const parts = formatter.formatToParts(now);
          const hourPart = parts.find((p) => p.type === 'hour');
          const localHour = hourPart
            ? String(parseInt(hourPart.value, 10) % 24)
            : hour;
          pipe.hincrby(`${KEY_PREFIX}:hour_tz:${day}`, localHour, 1);
          pipe.expire(`${KEY_PREFIX}:hour_tz:${day}`, ttl);
        } catch {
          // invalid timezone, skip
        }
      }

      void pipe.exec().catch((error: unknown) => {
        this.redisService.setLastError(
          error instanceof Error
            ? error.message
            : 'Failed writing analytics page_view',
        );
        console.error(
          'Analytics write error (page_view):',
          this.redisService.getLastError(),
        );
      });
      this.pushToBuffer({
        eventType: 'page_view',
        sessionId,
        ipHash: this.hashIp(ip),
        country: countryCode,
        device,
        browser,
        os,
        timezone: body.timezone,
        path,
        referrer,
        utmSource,
        utmMedium,
        utmCampaign,
        createdAt: now,
      });
      return;
    }

    if (body.event === LIKE_EVENT) {
      const pipe = this.redis.pipeline();
      pipe.incr(`${KEY_PREFIX}:like:${day}`);
      pipe.expire(`${KEY_PREFIX}:like:${day}`, ttl);
      void pipe.exec().catch((error: unknown) => {
        this.redisService.setLastError(
          error instanceof Error
            ? error.message
            : 'Failed writing analytics like',
        );
        console.error(
          'Analytics write error (like):',
          this.redisService.getLastError(),
        );
      });
      this.pushToBuffer({
        eventType: 'like',
        sessionId,
        ipHash: this.hashIp(ip),
        country: countryCode,
        device,
        browser,
        os,
        createdAt: now,
      });
      return;
    }

    if (body.event && FUNNEL_EVENTS.includes(body.event as FunnelEvent)) {
      const event = body.event as FunnelEvent;
      const pipe = this.redis.pipeline();
      pipe.hincrby(`${KEY_PREFIX}:funnel:event:${day}`, event, 1);
      pipe.expire(`${KEY_PREFIX}:funnel:event:${day}`, ttl);
      pipe.hincrby(
        `${KEY_PREFIX}:funnel:source:${day}`,
        `${utmSource}|${event}`,
        1,
      );
      pipe.expire(`${KEY_PREFIX}:funnel:source:${day}`, ttl);
      pipe.hincrby(`${KEY_PREFIX}:funnel:path:${day}`, `${path}|${event}`, 1);
      pipe.expire(`${KEY_PREFIX}:funnel:path:${day}`, ttl);
      void pipe.exec().catch((error: unknown) => {
        this.redisService.setLastError(
          error instanceof Error
            ? error.message
            : 'Failed writing funnel analytics',
        );
        console.error(
          'Analytics write error (funnel):',
          this.redisService.getLastError(),
        );
      });
      this.pushToBuffer({
        eventType: event,
        sessionId,
        ipHash: this.hashIp(ip),
        country: countryCode,
        device,
        browser,
        os,
        path,
        utmSource,
        utmMedium,
        utmCampaign,
        createdAt: now,
      });
      return;
    }

    if (body.event === 'page_leave' && body.enteredAt && body.leftAt) {
      const entered = new Date(body.enteredAt).getTime();
      const left = new Date(body.leftAt).getTime();
      if (!Number.isNaN(entered) && !Number.isNaN(left) && left > entered) {
        const durationSec = Math.round((left - entered) / 1000);
        if (durationSec >= 0 && durationSec <= 86400) {
          // max 24h
          const durationBucket = this.durationBucket(durationSec);
          const pipe = this.redis.pipeline();
          pipe.hincrby(`${KEY_PREFIX}:duration_hist:${day}`, durationBucket, 1);
          pipe.expire(`${KEY_PREFIX}:duration_hist:${day}`, ttl);
          pipe.incrby(`${KEY_PREFIX}:duration_sum:${day}`, durationSec);
          pipe.expire(`${KEY_PREFIX}:duration_sum:${day}`, ttl);
          pipe.incr(`${KEY_PREFIX}:duration_count:${day}`);
          pipe.expire(`${KEY_PREFIX}:duration_count:${day}`, ttl);
          void pipe.exec().catch((error: unknown) => {
            this.redisService.setLastError(
              error instanceof Error
                ? error.message
                : 'Failed writing analytics duration',
            );
            console.error(
              'Analytics write error (duration):',
              this.redisService.getLastError(),
            );
          });
          this.pushToBuffer({
            eventType: 'page_leave',
            sessionId,
            ipHash: this.hashIp(ip),
            country: countryCode,
            device,
            browser,
            os,
            path,
            durationSeconds: durationSec,
            createdAt: now,
          });
          // Bounce: single pageview + left within 30s — two-step, not pipelined (not idempotent)
          if (durationSec < 30) {
            this.hget(`${KEY_PREFIX}:session_pages:${day}`, sessionId)
              .then((count) => {
                if (count === '1' && this.redis) {
                  void this.incr(`${KEY_PREFIX}:bounces:${day}`).catch(
                    (error: unknown) => {
                      this.redisService.setLastError(
                        error instanceof Error
                          ? error.message
                          : 'Failed writing bounce incr',
                      );
                      console.error(
                        'Analytics write error (bounce incr):',
                        this.redisService.getLastError(),
                      );
                    },
                  );
                }
              })
              .catch((error: unknown) => {
                this.redisService.setLastError(
                  error instanceof Error
                    ? error.message
                    : 'Failed reading session pages for bounce',
                );
                console.error(
                  'Analytics write error (bounce hget):',
                  this.redisService.getLastError(),
                );
              });
          }
        }
      }
      return;
    }

    // Catch-all: server-side events (review_created, vote_cast, etc.)
    // No Redis counters — PG buffer only.
    if (body.event) {
      this.pushToBuffer({
        eventType: body.event,
        sessionId,
        userId: body.userId,
        ipHash: this.hashIp(ip),
        country: countryCode,
        device,
        browser,
        os,
        path,
        properties: body.properties,
        createdAt: now,
      });
    }
  }

  /**
   * Pre-compute cohort retention for the last 35 days and store as
   * SET analytics:retention:{day} JSON. Runs hourly via setInterval.
   * Replaces the O(N*SMEMBERS) call that was in getStats().
   */
  private async computeRetention(): Promise<void> {
    if (!this.redisService.isReady() || !this.redis) return;

    const now = new Date();
    const days: string[] = [];
    for (let i = 0; i < 35; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    for (const day of days) {
      try {
        const cohortMembers = await this.redis.smembers(
          `${KEY_PREFIX}:cohort:${day}`,
        );
        if (cohortMembers.length === 0) continue;

        const day1 = this.addDays(day, 1);
        const day7 = this.addDays(day, 7);
        const day30 = this.addDays(day, 30);
        const [pages1, pages7, pages30] = await Promise.all([
          this.redis.hgetall(`${KEY_PREFIX}:session_pages:${day1}`),
          this.redis.hgetall(`${KEY_PREFIX}:session_pages:${day7}`),
          this.redis.hgetall(`${KEY_PREFIX}:session_pages:${day30}`),
        ]);
        const set1 = new Set(Object.keys(pages1 || {}));
        const set7 = new Set(Object.keys(pages7 || {}));
        const set30 = new Set(Object.keys(pages30 || {}));

        let returned1 = 0;
        let returned7 = 0;
        let returned30 = 0;
        for (const sid of cohortMembers) {
          if (set1.has(sid)) returned1 += 1;
          if (set7.has(sid)) returned7 += 1;
          if (set30.has(sid)) returned30 += 1;
        }

        const cohortSize = cohortMembers.length;
        const result = {
          day1Pct: Math.round((returned1 / cohortSize) * 1000) / 10,
          day7Pct: Math.round((returned7 / cohortSize) * 1000) / 10,
          day30Pct: Math.round((returned30 / cohortSize) * 1000) / 10,
          cohortSize,
        };

        await this.redis.set(
          `${KEY_PREFIX}:retention:${day}`,
          JSON.stringify(result),
          'EX',
          48 * 60 * 60, // 48h TTL
        );
      } catch {
        // non-fatal, continue with next day
      }
    }
  }

  private bucketLongTail(
    source: Record<string, number>,
    limit: number,
  ): Record<string, number> {
    const sorted = Object.entries(source).sort((a, b) => b[1] - a[1]);
    if (sorted.length <= limit) return source;
    const keep = sorted.slice(0, limit - 1);
    const other = sorted
      .slice(limit - 1)
      .reduce((sum, [, value]) => sum + value, 0);
    return Object.fromEntries([...keep, ['other', other]]);
  }

  private parseFunnelMap(
    input: Record<string, number>,
  ): Record<
    string,
    { signup_started: number; signup_completed: number; purchase: number }
  > {
    const out: Record<
      string,
      { signup_started: number; signup_completed: number; purchase: number }
    > = {};
    Object.entries(input).forEach(([key, value]) => {
      const idx = key.lastIndexOf('|');
      if (idx <= 0) return;
      const entity = key.slice(0, idx);
      const event = key.slice(idx + 1) as FunnelEvent;
      if (!FUNNEL_EVENTS.includes(event)) return;
      if (!out[entity]) {
        out[entity] = { signup_started: 0, signup_completed: 0, purchase: 0 };
      }
      out[entity][event] += value;
    });
    return out;
  }

  private approximateDurationPercentile(
    histogram: Record<string, number>,
    totalCount: number,
    percentile: number,
  ): number {
    if (totalCount <= 0) return 0;
    const target = Math.ceil(totalCount * percentile);
    let running = 0;
    for (const bucket of DURATION_BUCKETS) {
      const count = histogram[bucket.label] || 0;
      running += count;
      if (running >= target) {
        return Number.isFinite(bucket.max) ? bucket.max : 1800;
      }
    }
    return 0;
  }

  /**
   * Read historical days from the AnalyticsDailySummary EAV table in PostgreSQL.
   * Reconstructs the same accumulator shape used by the Redis day loop in getStats().
   * Returns null if PrismaService is not injected.
   */
  async readDayRangeFromPg(days: string[]): Promise<PgPartialStats | null> {
    if (!this.prisma || days.length === 0) return null;

    const fromDate = new Date(days[0] + 'T00:00:00Z');
    const toDate = new Date(days[days.length - 1] + 'T00:00:00Z');

    const rows = await this.prisma.analyticsDailySummary.findMany({
      where: {
        date: { gte: fromDate, lte: toDate },
      },
    });

    // Initialize accumulator
    const acc: PgPartialStats = {
      totalPageviews: 0,
      totalBounces: 0,
      durationSum: 0,
      durationCount: 0,
      totalLikes: 0,
      totalUniques: 0,
      totalSessions: 0,
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
      pathCounts: {},
      byHourTz: {},
      durationHistogram: {},
      funnelEventCounts: {},
      funnelBySourceRaw: {},
      funnelByPathRaw: {},
      timeSeries: [],
    };

    // Group rows by date for timeSeries construction
    const perDay = new Map<string, { pageviews: number; uniques: number }>();

    // Dimension → accumulator hash mapping
    const hashMap: Record<string, Record<string, number>> = {
      country: acc.byCountry,
      device: acc.byDevice,
      browser: acc.byBrowser,
      os: acc.byOs,
      referrer: acc.byReferrer,
      utm_source: acc.byUtmSource,
      utm_medium: acc.byUtmMedium,
      utm_campaign: acc.byUtmCampaign,
      hour: acc.byHour,
      weekday: acc.byWeekday,
      path: acc.pathCounts,
      hour_tz: acc.byHourTz,
      duration_bucket: acc.durationHistogram,
      funnel_event: acc.funnelEventCounts,
      funnel_by_source: acc.funnelBySourceRaw,
      funnel_by_path: acc.funnelByPathRaw,
    };

    for (const row of rows) {
      const dayStr =
        row.date instanceof Date
          ? row.date.toISOString().slice(0, 10)
          : String(row.date).slice(0, 10);

      if (row.dimension === '_total_') {
        // Scalar metrics
        switch (row.dimensionValue) {
          case 'pageviews':
            acc.totalPageviews += row.count;
            // Track per-day for timeSeries
            if (!perDay.has(dayStr))
              perDay.set(dayStr, { pageviews: 0, uniques: 0 });
            perDay.get(dayStr)!.pageviews += row.count;
            break;
          case 'bounces':
            acc.totalBounces += row.count;
            break;
          case 'duration_sum':
            acc.durationSum += row.count;
            break;
          case 'duration_count':
            acc.durationCount += row.count;
            break;
          case 'likes':
            acc.totalLikes += row.count;
            break;
          case 'uniques_approx':
            acc.totalUniques += row.count;
            // Track per-day for timeSeries
            if (!perDay.has(dayStr))
              perDay.set(dayStr, { pageviews: 0, uniques: 0 });
            perDay.get(dayStr)!.uniques += row.count;
            break;
          case 'sessions_approx':
            acc.totalSessions += row.count;
            break;
        }
      } else {
        // Hash/breakdown dimensions
        const target = hashMap[row.dimension];
        if (target) {
          target[row.dimensionValue] =
            (target[row.dimensionValue] || 0) + row.count;
        }
      }
    }

    // Build timeSeries from per-day data, sorted by date
    for (const day of days) {
      const entry = perDay.get(day);
      acc.timeSeries.push({
        date: day,
        pageviews: entry?.pageviews ?? 0,
        uniques: entry?.uniques ?? 0,
      });
    }

    return acc;
  }

  /**
   * Returns aggregated analytics for the full date range [from, to].
   * All metrics (pageviews, uniques, sessions, avg duration, bounce rate, likes, funnel, etc.)
   * are computed over this range. Only activeToday is for the single day "today".
   * Results are cached in memory for 1 minute per (from, to) to speed up repeated requests.
   */
  async getStats(from: string, to: string): Promise<AnalyticsStats | null> {
    if (!this.redis || !this.redisService.isReady())
      return this.emptyStats(from, to);

    const cacheKey = `${from}:${to}`;
    const now = Date.now();
    const hit = statsCache.get(cacheKey);
    if (hit && hit.expiry > now) {
      return { ...hit.data };
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()))
      return null;

    const days: string[] = [];
    for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
      days.push(this.dayKey(d));
    }

    // Partition days: pgDays (>= PG_CUTOFF_DAYS ago) read from PG, redisDays from Redis
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - PG_CUTOFF_DAYS);
    const cutoffStr = this.dayKey(cutoffDate);
    const pgDays = days.filter((d) => d < cutoffStr);
    const redisDays = days.filter((d) => d >= cutoffStr);

    // Read historical data from PG (returns null if Prisma not injected or no pgDays)
    const pgStats = await this.readDayRangeFromPg(pgDays);

    let totalPageviews = 0;
    let totalBounces = 0;
    let durationSum = 0;
    let durationCount = 0;
    const byCountry: Record<string, number> = {};
    const byDevice: Record<string, number> = {};
    const byBrowser: Record<string, number> = {};
    const byOs: Record<string, number> = {};
    const byReferrer: Record<string, number> = {};
    const byUtmSource: Record<string, number> = {};
    const byUtmMedium: Record<string, number> = {};
    const byUtmCampaign: Record<string, number> = {};
    const byHour: Record<string, number> = {};
    const byWeekday: Record<string, number> = {};
    const pathCounts: Record<string, number> = {};
    const durationHistogram: Record<string, number> = {};
    const funnelEventCounts: Record<FunnelEvent, number> = {
      signup_started: 0,
      signup_completed: 0,
      purchase: 0,
    };
    const funnelBySourceRaw: Record<string, number> = {};
    const funnelByPathRaw: Record<string, number> = {};
    const timeSeries: TimeSeriesPoint[] = [];
    let totalLikes = 0;
    const byHourTz: Record<string, number> = {};
    let retention:
      | {
          day1Pct: number;
          day7Pct: number;
          day30Pct: number;
          cohortDays: number;
        }
      | undefined;

    const WEEKDAY_NAMES: Record<string, string> = {
      '0': 'Sun',
      '1': 'Mon',
      '2': 'Tue',
      '3': 'Wed',
      '4': 'Thu',
      '5': 'Fri',
      '6': 'Sat',
    };

    try {
      for (const day of redisDays) {
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
          likeDay,
          hourTzDay,
        ] = await Promise.all([
          this.redis.get(`${KEY_PREFIX}:pageviews:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:country:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:device:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:browser:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:os:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:referrer:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:utm_source:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:utm_medium:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:utm_campaign:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:hour:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:weekday:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:path:${day}`),
          this.redis.get(`${KEY_PREFIX}:bounces:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:duration_hist:${day}`),
          this.redis.get(`${KEY_PREFIX}:duration_sum:${day}`),
          this.redis.get(`${KEY_PREFIX}:duration_count:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:funnel:event:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:funnel:source:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:funnel:path:${day}`),
          this.redis.pfcount(`${KEY_PREFIX}:hll:uniques:${day}`),
          this.redis.get(`${KEY_PREFIX}:like:${day}`),
          this.redis.hgetall(`${KEY_PREFIX}:hour_tz:${day}`),
        ]);

        const pvNum = parseInt(pv || '0', 10);
        totalPageviews += pvNum;
        totalBounces += parseInt(bounces || '0', 10);
        durationSum += parseInt(durationSumDay || '0', 10);
        durationCount += parseInt(durationCountDay || '0', 10);

        const merge = (
          acc: Record<string, number>,
          src?: Record<string, string> | null,
        ) => {
          Object.entries(src || {}).forEach(([k, v]) => {
            acc[k] = (acc[k] || 0) + parseInt(v, 10);
          });
        };
        merge(byCountry, countries);
        merge(byDevice, devices);
        merge(byBrowser, browsers);
        merge(byOs, oss);
        merge(byReferrer, referrers);
        merge(byUtmSource, utmSources);
        merge(byUtmMedium, utmMediums);
        merge(byUtmCampaign, utmCampaigns);
        merge(byHour, hours);
        merge(byWeekday, weekdays);
        merge(durationHistogram, durationHist);
        merge(funnelBySourceRaw, funnelBySourceDay);
        merge(funnelByPathRaw, funnelByPathDay);
        Object.entries(paths || {}).forEach(([k, v]) => {
          pathCounts[k] = (pathCounts[k] || 0) + parseInt(v, 10);
        });
        Object.entries(funnelEvents || {}).forEach(([event, count]) => {
          if (FUNNEL_EVENTS.includes(event as FunnelEvent)) {
            funnelEventCounts[event as FunnelEvent] += parseInt(count, 10);
          }
        });
        totalLikes += parseInt(likeDay || '0', 10);
        const mergeTz = (
          acc: Record<string, number>,
          src?: Record<string, string> | null,
        ) => {
          Object.entries(src || {}).forEach(([k, v]) => {
            acc[k] = (acc[k] || 0) + parseInt(v, 10);
          });
        };
        mergeTz(byHourTz, hourTzDay);

        timeSeries.push({
          date: day,
          pageviews: pvNum,
          uniques: uniquesDay || 0,
        });
      }

      // Read pre-computed retention from background job (avoids SMEMBERS in hot path)
      try {
        let totalCohort = 0;
        let weightedDay1 = 0;
        let weightedDay7 = 0;
        let weightedDay30 = 0;
        let cohortDaysCount = 0;
        for (const day of redisDays) {
          const raw = await this.redis.get(`${KEY_PREFIX}:retention:${day}`);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as {
            day1Pct: number;
            day7Pct: number;
            day30Pct: number;
            cohortSize: number;
          };
          if (!parsed.cohortSize) continue;
          cohortDaysCount += 1;
          totalCohort += parsed.cohortSize;
          weightedDay1 += parsed.day1Pct * parsed.cohortSize;
          weightedDay7 += parsed.day7Pct * parsed.cohortSize;
          weightedDay30 += parsed.day30Pct * parsed.cohortSize;
        }
        if (totalCohort > 0 && cohortDaysCount > 0) {
          retention = {
            day1Pct: Math.round((weightedDay1 / totalCohort) * 10) / 10,
            day7Pct: Math.round((weightedDay7 / totalCohort) * 10) / 10,
            day30Pct: Math.round((weightedDay30 / totalCohort) * 10) / 10,
            cohortDays: cohortDaysCount,
          };
        }
      } catch {
        retention = undefined;
      }
    } catch (error) {
      this.redisService.setLastError(
        error instanceof Error
          ? error.message
          : 'Failed reading analytics stats',
      );
      console.error('Analytics read error:', this.redisService.getLastError());
      return this.emptyStats(days[0] || from, days[days.length - 1] || to);
    }

    // Merge PG historical stats into Redis accumulators (item 2.21)
    if (pgStats) {
      const mergeHash = (
        target: Record<string, number>,
        source: Record<string, number>,
      ) => {
        for (const [k, v] of Object.entries(source)) {
          target[k] = (target[k] || 0) + v;
        }
      };

      // Additive scalars
      totalPageviews += pgStats.totalPageviews;
      totalBounces += pgStats.totalBounces;
      durationSum += pgStats.durationSum;
      durationCount += pgStats.durationCount;
      totalLikes += pgStats.totalLikes;

      // Additive hash dimensions
      mergeHash(byCountry, pgStats.byCountry);
      mergeHash(byDevice, pgStats.byDevice);
      mergeHash(byBrowser, pgStats.byBrowser);
      mergeHash(byOs, pgStats.byOs);
      mergeHash(byReferrer, pgStats.byReferrer);
      mergeHash(byUtmSource, pgStats.byUtmSource);
      mergeHash(byUtmMedium, pgStats.byUtmMedium);
      mergeHash(byUtmCampaign, pgStats.byUtmCampaign);
      mergeHash(byHour, pgStats.byHour);
      mergeHash(byWeekday, pgStats.byWeekday);
      mergeHash(pathCounts, pgStats.pathCounts);
      mergeHash(byHourTz, pgStats.byHourTz);

      // Histogram merge for percentiles (sum bucket counts, recompute later)
      mergeHash(durationHistogram, pgStats.durationHistogram);

      // Funnel merges (cast needed: funnelEventCounts is Record<FunnelEvent, number>)
      mergeHash(
        funnelEventCounts as Record<string, number>,
        pgStats.funnelEventCounts,
      );
      mergeHash(funnelBySourceRaw, pgStats.funnelBySourceRaw);
      mergeHash(funnelByPathRaw, pgStats.funnelByPathRaw);

      // TimeSeries: prepend PG entries before Redis entries (already sorted by date)
      timeSeries.unshift(...pgStats.timeSeries);
    }

    // Redis HLL PFCOUNT for exact cross-day uniques/sessions (Redis window only)
    const uniqueHllKeys = redisDays.map(
      (day) => `${KEY_PREFIX}:hll:uniques:${day}`,
    );
    const sessionHllKeys = redisDays.map(
      (day) => `${KEY_PREFIX}:hll:sessions:${day}`,
    );
    // Redis provides exact HLL union; PG provides summed per-day snapshots
    const redisUniques =
      uniqueHllKeys.length > 0 ? await this.redis.pfcount(...uniqueHllKeys) : 0;
    const redisSessions =
      sessionHllKeys.length > 0
        ? await this.redis.pfcount(...sessionHllKeys)
        : 0;
    // Combine: PG sum (approximate) + Redis HLL union (exact for Redis window)
    const totalUniques = redisUniques + (pgStats?.totalUniques ?? 0);
    const totalSessions = redisSessions + (pgStats?.totalSessions ?? 0);

    const topPages = Object.entries(pathCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([path, pageviews]) => ({ path, pageviews }));

    const avgDurationSeconds =
      durationCount > 0 ? durationSum / durationCount : 0;
    const durationP50Seconds = this.approximateDurationPercentile(
      durationHistogram,
      durationCount,
      0.5,
    );
    const durationP95Seconds = this.approximateDurationPercentile(
      durationHistogram,
      durationCount,
      0.95,
    );
    const bounceRate =
      totalSessions > 0 ? (totalBounces / totalSessions) * 100 : 0;

    const today = this.dayKey(new Date());
    let activeToday = 0;
    if (days.includes(today)) {
      try {
        activeToday = await this.pfcount(`${KEY_PREFIX}:hll:uniques:${today}`);
      } catch {
        activeToday = 0;
      }
    }

    const byWeekdayNamed: Record<string, number> = {};
    Object.entries(byWeekday).forEach(([k, v]) => {
      byWeekdayNamed[WEEKDAY_NAMES[k] ?? k] = v;
    });

    const byReferrerBucketed = this.bucketLongTail(byReferrer, 15);
    const funnelByUtmSource = Object.entries(
      this.parseFunnelMap(funnelBySourceRaw),
    )
      .map(([utmSource, counts]) => ({ utmSource, ...counts }))
      .sort(
        (a, b) =>
          b.signup_started + b.purchase - (a.signup_started + a.purchase),
      )
      .slice(0, 20);
    const funnelByPath = Object.entries(this.parseFunnelMap(funnelByPathRaw))
      .map(([path, counts]) => ({ path, ...counts }))
      .sort(
        (a, b) =>
          b.signup_started + b.purchase - (a.signup_started + a.purchase),
      )
      .slice(0, 20);

    const signupCompletionRate =
      funnelEventCounts.signup_started > 0
        ? (funnelEventCounts.signup_completed /
            funnelEventCounts.signup_started) *
          100
        : 0;
    const purchaseRate =
      funnelEventCounts.signup_started > 0
        ? (funnelEventCounts.purchase / funnelEventCounts.signup_started) * 100
        : 0;

    const result = {
      totalPageviews,
      totalUniques,
      totalSessions,
      activeToday,
      byCountry,
      byDevice,
      byBrowser,
      byOs,
      byReferrer: byReferrerBucketed,
      byUtmSource,
      byUtmMedium,
      byUtmCampaign,
      byHour,
      byWeekday: byWeekdayNamed,
      topPages,
      avgDurationSeconds,
      durationP50Seconds,
      durationP95Seconds,
      totalBounces,
      bounceRate,
      timeSeries,
      dateRange: { from: days[0] || from, to: days[days.length - 1] || to },
      likes: totalLikes,
      sales: funnelEventCounts.purchase,
      newMembersInRange: 0,
      funnel: {
        signup_started: funnelEventCounts.signup_started,
        signup_completed: funnelEventCounts.signup_completed,
        purchase: funnelEventCounts.purchase,
        signupCompletionRate,
        purchaseRate,
      },
      funnelByUtmSource,
      funnelByPath,
      byHourTz: Object.keys(byHourTz).length > 0 ? byHourTz : undefined,
      retention,
    };
    statsCache.set(cacheKey, {
      data: result,
      expiry: now + STATS_CACHE_TTL_MS,
    });
    for (const key of statsCache.keys()) {
      const entry = statsCache.get(key);
      if (entry !== undefined && entry.expiry <= Date.now())
        statsCache.delete(key);
    }
    return result;
  }

  /** Real-time: active visitors in last 5 minutes and count by country. */
  async getRealtime(): Promise<{
    activeNow: number;
    byCountry: Record<string, number>;
  }> {
    const out = { activeNow: 0, byCountry: {} as Record<string, number> };
    if (!this.redis || !this.redisService.isReady()) return out;

    const nowMs = Date.now();
    const minScore = nowMs - RECENT_WINDOW_MS;
    try {
      const members = await this.redis.zrangebyscore(
        KEY_RECENT_SESSIONS,
        minScore,
        '+inf',
      );
      const seen = new Set<string>();
      for (const m of members) {
        const idx = m.lastIndexOf(':');
        const sessionId = idx >= 0 ? m.slice(0, idx) : m;
        const country = idx >= 0 ? m.slice(idx + 1) : 'unknown';
        if (!seen.has(sessionId)) {
          seen.add(sessionId);
          out.activeNow += 1;
        }
        out.byCountry[country] = (out.byCountry[country] || 0) + 1;
      }
    } catch {
      // ignore
    }
    return out;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const pong = await this.redis.ping();
      if (pong === 'PONG') {
        this.redisService.setLastError(null);
        return true;
      }
      return false;
    } catch (error) {
      this.redisService.setLastError(
        error instanceof Error ? error.message : 'Redis ping failed',
      );
      console.error(
        'Analytics Redis health check failed:',
        this.redisService.getLastError(),
      );
      return false;
    }
  }

  /**
   * GDPR: Nullify userId on all analytics_events for a deleted user.
   * Preparatory hook — called by user account deletion when implemented.
   */
  async anonymizeUserAnalytics(userId: string): Promise<number> {
    if (!this.prisma) return 0;
    const result = await this.prisma
      .$executeRaw`UPDATE analytics_events SET user_id = NULL WHERE user_id = ${userId}`;
    return result;
  }

  /**
   * GDPR 90-day retention: nullify userId on analytics_events older than 90 days.
   * Runs on an hourly timer but uses Redis guards to ensure only one run per day.
   */
  async anonymizeExpiredUsers(): Promise<void> {
    if (!this.prisma || !this.redisService.isReady()) return;
    const redis = this.redis;
    if (!redis) return;

    const today = new Date().toISOString().slice(0, 10);
    const ranKey = `analytics:anonymize:ran:${today}`;
    const runningKey = 'analytics:anonymize:running';

    // Guard 1: already ran today?
    const alreadyRan = await redis.get(ranKey);
    if (alreadyRan) return;

    // Guard 2: acquire running lock (2h TTL safety valve)
    const acquired = await redis.set(runningKey, '1', 'EX', 7200, 'NX');
    if (!acquired) return;

    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - ANONYMIZE_RETENTION_DAYS);

      // Count rows to decide batch vs single
      const countResult: { count: bigint }[] = await this.prisma
        .$queryRaw`SELECT COUNT(*) as count FROM analytics_events WHERE user_id IS NOT NULL AND created_at < ${cutoff}`;
      const rowCount = Number(countResult[0]?.count ?? 0);

      if (rowCount === 0) {
        await redis.set(ranKey, '1', 'EX', 86400);
        return;
      }

      if (rowCount <= ANONYMIZE_BATCH_THRESHOLD) {
        // Single UPDATE for steady-state
        await this.prisma.$executeRaw`SET LOCAL synchronous_commit = off`;
        await this.prisma
          .$executeRaw`UPDATE analytics_events SET user_id = NULL WHERE user_id IS NOT NULL AND created_at < ${cutoff}`;
      } else {
        // Batch by calendar day for large backfills
        const oldestResult: { min_date: Date | null }[] = await this.prisma
          .$queryRaw`SELECT MIN(created_at) as min_date FROM analytics_events WHERE user_id IS NOT NULL AND created_at < ${cutoff}`;
        const oldestDate = oldestResult[0]?.min_date;
        if (oldestDate) {
          const dayStart = new Date(oldestDate);
          dayStart.setHours(0, 0, 0, 0);

          while (dayStart < cutoff) {
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayEnd.getDate() + 1);

            await this.prisma.$executeRaw`SET LOCAL synchronous_commit = off`;
            await this.prisma
              .$executeRaw`UPDATE analytics_events SET user_id = NULL WHERE user_id IS NOT NULL AND created_at >= ${dayStart} AND created_at < ${dayEnd}`;

            dayStart.setDate(dayStart.getDate() + 1);
          }
        }
      }

      // Mark today as done
      await redis.set(ranKey, '1', 'EX', 86400);
    } catch (err) {
      console.error('GDPR anonymization error:', err);
    } finally {
      await redis.del(runningKey);
    }
  }

  isEnabled(): boolean {
    return this.redisService.isReady();
  }

  getHealthDetails(): {
    configured: boolean;
    connected: boolean;
    lastError: string | null;
  } {
    return {
      configured: Boolean(process.env.REDIS_URL?.trim()),
      connected: this.redisService.isReady(),
      lastError: this.redisService.getLastError(),
    };
  }

  async getRollupHealth(): Promise<{
    lastSuccessDate: string | null;
    stale: boolean;
  }> {
    if (!this.redis) return { lastSuccessDate: null, stale: true };
    const lastSuccess = await this.redis.get('analytics:rollup:last_success');
    if (!lastSuccess) return { lastSuccessDate: null, stale: true };
    const lastDate = new Date(lastSuccess + 'T00:00:00Z');
    const hoursSince = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60);
    return {
      lastSuccessDate: lastSuccess,
      stale: hoursSince >= 48,
    };
  }
}
