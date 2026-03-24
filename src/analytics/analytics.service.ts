import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from '../redis/redis.service';
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

export interface TrackPayload {
  path?: string;
  device?: string; // userAgent
  timezone?: string;
  event?: 'page_view' | 'page_leave' | FunnelEvent | 'like';
  sessionId?: string;
  enteredAt?: string; // ISO date
  leftAt?: string; // ISO date
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  /** When false, do not store (user declined cookies). When true or omitted, store. */
  consent?: boolean;
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

@Injectable()
export class AnalyticsService {
  constructor(private readonly redisService: RedisService) {}

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
    if (!normalizedIp || isPrivateOrLocalIp(normalizedIp))
      return 'unknown';

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

    if (body.event === 'page_view' || !body.event) {
      const nowMs = now.getTime();
      const member = `${sessionId}:${countryCode}`;
      const promises: Promise<void>[] = [
        this.incr(`${KEY_PREFIX}:pageviews:${day}`),
        this.pfadd(`${KEY_PREFIX}:hll:uniques:${day}`, sessionId),
        this.pfadd(`${KEY_PREFIX}:hll:sessions:${day}`, sessionId),
        this.hincrby(`${KEY_PREFIX}:country:${day}`, countryCode, 1),
        this.hincrby(`${KEY_PREFIX}:device:${day}`, device, 1),
        this.hincrby(`${KEY_PREFIX}:browser:${day}`, browser, 1),
        this.hincrby(`${KEY_PREFIX}:os:${day}`, os, 1),
        this.hincrby(`${KEY_PREFIX}:referrer:${day}`, referrer, 1),
        this.hincrby(`${KEY_PREFIX}:utm_source:${day}`, utmSource, 1),
        this.hincrby(`${KEY_PREFIX}:utm_medium:${day}`, utmMedium, 1),
        this.hincrby(`${KEY_PREFIX}:utm_campaign:${day}`, utmCampaign, 1),
        this.hincrby(`${KEY_PREFIX}:hour:${day}`, hour, 1),
        this.hincrby(`${KEY_PREFIX}:weekday:${day}`, weekday, 1),
        this.hincrby(`${KEY_PREFIX}:path:${day}`, path, 1),
        this.hincrby(`${KEY_PREFIX}:session_pages:${day}`, sessionId, 1),
        this.addRecentSession(nowMs, member),
      ];
      const cohortTtl = 35 * 24 * 60 * 60;
      this.redis
        .set(
          `${KEY_PREFIX}:first_visit:${sessionId}`,
          day,
          'EX',
          cohortTtl,
          'NX',
        )
        .then((reply) => {
          if (reply === 'OK' && this.redis) {
            this.redis
              .sadd(`${KEY_PREFIX}:cohort:${day}`, sessionId)
              .catch((error: unknown) => {
                this.redisService.setLastError(
                  error instanceof Error
                    ? error.message
                    : 'Failed writing cohort sadd',
                );
                console.error(
                  'Analytics write error (cohort sadd):',
                  this.redisService.getLastError(),
                );
              });
            this.redis
              .expire(`${KEY_PREFIX}:cohort:${day}`, cohortTtl)
              .catch((error: unknown) => {
                this.redisService.setLastError(
                  error instanceof Error
                    ? error.message
                    : 'Failed writing cohort expire',
                );
                console.error(
                  'Analytics write error (cohort expire):',
                  this.redisService.getLastError(),
                );
              });
          }
        })
        .catch((error: unknown) => {
          this.redisService.setLastError(
            error instanceof Error
              ? error.message
              : 'Failed writing cohort first_visit',
          );
          console.error(
            'Analytics write error (cohort first_visit):',
            this.redisService.getLastError(),
          );
        });
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
          promises.push(
            this.hincrby(`${KEY_PREFIX}:hour_tz:${day}`, localHour, 1),
          );
        } catch {
          // invalid timezone, skip
        }
      }
      void Promise.all(promises).catch((error: unknown) => {
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
      return;
    }

    if (body.event === LIKE_EVENT) {
      void this.incr(`${KEY_PREFIX}:like:${day}`).catch((error: unknown) => {
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
      return;
    }

    if (body.event && FUNNEL_EVENTS.includes(body.event as FunnelEvent)) {
      const event = body.event as FunnelEvent;
      void Promise.all([
        this.hincrby(`${KEY_PREFIX}:funnel:event:${day}`, event, 1),
        this.hincrby(
          `${KEY_PREFIX}:funnel:source:${day}`,
          `${utmSource}|${event}`,
          1,
        ),
        this.hincrby(`${KEY_PREFIX}:funnel:path:${day}`, `${path}|${event}`, 1),
      ]).catch((error: unknown) => {
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
          void Promise.all([
            this.hincrby(
              `${KEY_PREFIX}:duration_hist:${day}`,
              durationBucket,
              1,
            ),
            this.incrby(`${KEY_PREFIX}:duration_sum:${day}`, durationSec),
            this.incr(`${KEY_PREFIX}:duration_count:${day}`),
          ]).catch((error: unknown) => {
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
          // Bounce: single pageview + left within 30s
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
      for (const day of days) {
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

      try {
        let totalCohort = 0;
        let totalReturned1 = 0;
        let totalReturned7 = 0;
        let totalReturned30 = 0;
        let cohortDaysCount = 0;
        for (const day of days) {
          const cohortMembers = await this.redis.smembers(
            `${KEY_PREFIX}:cohort:${day}`,
          );
          const cohortSize = cohortMembers.length;
          if (cohortSize === 0) continue;
          cohortDaysCount += 1;
          totalCohort += cohortSize;
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
          for (const sid of cohortMembers) {
            if (set1.has(sid)) totalReturned1 += 1;
            if (set7.has(sid)) totalReturned7 += 1;
            if (set30.has(sid)) totalReturned30 += 1;
          }
        }
        if (totalCohort > 0 && cohortDaysCount > 0) {
          retention = {
            day1Pct: Math.round((totalReturned1 / totalCohort) * 1000) / 10,
            day7Pct: Math.round((totalReturned7 / totalCohort) * 1000) / 10,
            day30Pct: Math.round((totalReturned30 / totalCohort) * 1000) / 10,
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

    const uniqueHllKeys = days.map((day) => `${KEY_PREFIX}:hll:uniques:${day}`);
    const sessionHllKeys = days.map(
      (day) => `${KEY_PREFIX}:hll:sessions:${day}`,
    );
    const totalUniques =
      uniqueHllKeys.length > 0 ? await this.redis.pfcount(...uniqueHllKeys) : 0;
    const totalSessions =
      sessionHllKeys.length > 0
        ? await this.redis.pfcount(...sessionHllKeys)
        : 0;

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
}
