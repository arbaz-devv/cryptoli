import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { isIP } from 'node:net';
import Redis from 'ioredis';
import * as geoip from 'geoip-lite';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const UAParser = require('ua-parser-js') as new (ua?: string) => { getResult: () => { device?: { type?: string }; browser?: { name?: string }; os?: { name?: string } } };

const KEY_PREFIX = 'analytics';
const TTL_DAYS = 32;
const MAX_DURATIONS_PER_DAY = 10000;

export interface TrackPayload {
  path?: string;
  device?: string; // userAgent
  timezone?: string;
  event?: 'page_view' | 'page_leave';
  sessionId?: string;
  enteredAt?: string; // ISO date
  leftAt?: string;   // ISO date
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}

export interface TimeSeriesPoint {
  date: string;
  pageviews: number;
  uniques: number;
}

export interface AnalyticsStats {
  totalPageviews: number;
  totalUniques: number;
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
  topPages: { path: string; pageviews: number }[];
  avgDurationSeconds: number;
  totalBounces: number;
  bounceRate: number; // 0-100
  timeSeries: TimeSeriesPoint[];
  dateRange: { from: string; to: string };
}

@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private redis: Redis | null = null;
  private enabled = false;

  constructor() {
    const url = process.env.REDIS_URL;
    if (url && url.trim()) {
      try {
        this.redis = new Redis(url, { maxRetriesPerRequest: 10 });
        this.redis.on('error', () => {}); // avoid crashing if Redis is down
        this.enabled = true;
      } catch {
        this.enabled = false;
      }
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }

  private dayKey(date: Date): string {
    return date.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private async incr(key: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.incr(key);
    await this.redis.expire(key, TTL_DAYS * 24 * 60 * 60);
  }

  private async sadd(key: string, ...members: string[]): Promise<void> {
    if (!this.redis) return;
    await this.redis.sadd(key, ...members);
    await this.redis.expire(key, TTL_DAYS * 24 * 60 * 60);
  }

  private async hincrby(key: string, field: string, delta: number): Promise<void> {
    if (!this.redis) return;
    await this.redis.hincrby(key, field, delta);
    await this.redis.expire(key, TTL_DAYS * 24 * 60 * 60);
  }

  private async hget(key: string, field: string): Promise<string | null> {
    if (!this.redis) return null;
    return this.redis.hget(key, field);
  }

  private async lpushLimit(key: string, ...values: string[]): Promise<void> {
    if (!this.redis) return;
    await this.redis.lpush(key, ...values);
    await this.redis.ltrim(key, 0, MAX_DURATIONS_PER_DAY - 1);
    await this.redis.expire(key, TTL_DAYS * 24 * 60 * 60);
  }

  /**
   * Resolve country code for an IP:
   * 1) Try local geoip-lite database
   * 2) If unknown, optionally call external IP->country API
   * 3) Cache successful lookups in Redis to avoid repeated API calls
   */
  private normalizeIp(rawIp: string): string {
    const ip = (rawIp || '').trim();
    if (!ip) return '';

    // Bracketed IPv6 with optional port: [2001:db8::1]:443
    const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracketed?.[1]) {
      const candidate = bracketed[1].split('%')[0];
      return isIP(candidate) ? candidate : '';
    }

    // IPv4 with port: 1.2.3.4:1234
    const ipv4Port = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (ipv4Port?.[1]) {
      return isIP(ipv4Port[1]) ? ipv4Port[1] : '';
    }

    const deMapped = ip.replace(/^::ffff:/i, '').split('%')[0];
    return isIP(deMapped) ? deMapped : '';
  }

  private isPrivateOrLocalIp(ip: string): boolean {
    if (!ip) return true;
    if (ip === '::1') return true;

    // Common private/local IPv4 ranges.
    if (/^127\./.test(ip)) return true;
    if (/^10\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
    if (/^169\.254\./.test(ip)) return true;

    // Private/link-local/unique-local IPv6 ranges.
    const v6 = ip.toLowerCase();
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
    if (v6.startsWith('fe80:')) return true;

    return false;
  }

  private isValidCountryCode(code?: string): boolean {
    return /^[A-Z]{2}$/.test((code || '').trim().toUpperCase());
  }

  private async resolveCountry(ip: string, countryHint?: string): Promise<string> {
    const hint = (countryHint || '').trim().toUpperCase();
    if (this.isValidCountryCode(hint)) return hint;

    const normalizedIp = this.normalizeIp(ip);

console.log("normalizedIp", normalizedIp);    
    if (!normalizedIp || this.isPrivateOrLocalIp(normalizedIp)) return 'unknown';

    const cacheKey = `${KEY_PREFIX}:ip_country:${normalizedIp}`;
    if (this.redis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) return cached;
      } catch {
        // ignore cache read errors, fall through
      }
    }

    // First try local geoip-lite
    const { country } = this.getGeo(normalizedIp);
    let countryCode = (country || '').toUpperCase();

    // Fallback to external API only if still unknown
    if (!countryCode || countryCode === 'UNKNOWN') {
      try {
        const res = await fetch(`https://ipwho.is/${encodeURIComponent(normalizedIp)}?fields=success,country_code`);
        console.log(res,'res');
        
        if (res.ok) {
          const json = (await res.json()) as { success?: boolean; country_code?: string };
          if (json.success === true && json.country_code) {
            countryCode = json.country_code.toUpperCase();
          }
        }
      } catch {
        // ignore external lookup errors, keep unknown
      }
    }

    if (!this.isValidCountryCode(countryCode)) countryCode = 'unknown';

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

  private getGeo(ip: string): { country?: string; city?: string; region?: string } {
    const geo = geoip.lookup(ip);
    if (!geo) return {};
    return {
      country: geo.country || undefined,
      city: geo.city,
      region: geo.region,
    };
  }

  private getDeviceAndBrowser(userAgent: string): { device: string; browser: string; os: string } {
    const parser = new UAParser(userAgent || '');
    const result = parser.getResult() as { device?: { type?: string }; browser?: { name?: string }; os?: { name?: string } };
    const d = (result.device?.type || 'desktop').toLowerCase();
    const deviceType = d === 'mobile' || d === 'tablet' ? d : 'desktop';
    return {
      device: deviceType,
      browser: (result.browser?.name || 'unknown').toLowerCase().replace(/\s+/g, '_'),
      os: (result.os?.name || 'unknown').toLowerCase().replace(/\s+/g, '_'),
    };
  }

  private referrerLabel(referrer?: string): string {
    if (!referrer || !referrer.trim()) return 'direct';
    try {
      const u = new URL(referrer);
      return u.hostname || 'direct';
    } catch {
      return 'direct';
    }
  }

  /** Non-blocking: enqueue track and return immediately. */
  async track(ip: string, userAgent: string, body: TrackPayload, countryHint?: string): Promise<void> {

console.log("ip", ip);    
    if (!this.enabled || !this.redis) return;

    const now = new Date();
    const day = this.dayKey(now);
    const countryCode = await this.resolveCountry(ip, countryHint);
    const { device, browser, os } = this.getDeviceAndBrowser(userAgent || body.device || '');
    const path = (body.path || '/').replace(/^\/+/, '/') || '/';
    const sessionId = body.sessionId || `ip-${ip}`;
    const referrer = this.referrerLabel(body.referrer);
    const utmSource = (body.utm_source || '').trim() || 'none';
    const utmMedium = (body.utm_medium || '').trim() || 'none';
    const utmCampaign = (body.utm_campaign || '').trim() || 'none';
    const hour = String(now.getHours());
    const weekday = String(now.getDay()); // 0-6

    if (body.event === 'page_view' || !body.event) {
      void Promise.all([
        this.incr(`${KEY_PREFIX}:pageviews:${day}`),
        this.sadd(`${KEY_PREFIX}:uniques:${day}`, sessionId),
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
      ]).catch(() => {});
      return;
    }

    if (body.event === 'page_leave' && body.enteredAt && body.leftAt) {
      const entered = new Date(body.enteredAt).getTime();
      const left = new Date(body.leftAt).getTime();
      if (!Number.isNaN(entered) && !Number.isNaN(left) && left > entered) {
        const durationSec = Math.round((left - entered) / 1000);
        if (durationSec >= 0 && durationSec <= 86400) { // max 24h
          void this.lpushLimit(`${KEY_PREFIX}:durations:${day}`, String(durationSec)).catch(() => {});
          // Bounce: single pageview + left within 30s
          if (durationSec < 30) {
            this.hget(`${KEY_PREFIX}:session_pages:${day}`, sessionId).then((count) => {
              if (count === '1' && this.redis) {
                void this.incr(`${KEY_PREFIX}:bounces:${day}`).catch(() => {});
              }
            }).catch(() => {});
          }
        }
      }
    }
  }

  async getStats(from: string, to: string): Promise<AnalyticsStats | null> {
    if (!this.redis) return null;

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return null;

    const days: string[] = [];
    for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
      days.push(this.dayKey(d));
    }

    let totalPageviews = 0;
    let totalBounces = 0;
    const uniquesSet = new Set<string>();
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
    const durations: number[] = [];
    const timeSeries: TimeSeriesPoint[] = [];

    const WEEKDAY_NAMES: Record<string, string> = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat' };

    for (const day of days) {
      const [pv, uniques, countries, devices, browsers, oss, referrers, utmSources, utmMediums, utmCampaigns, hours, weekdays, paths, durList, bounces] = await Promise.all([
        this.redis.get(`${KEY_PREFIX}:pageviews:${day}`),
        this.redis.smembers(`${KEY_PREFIX}:uniques:${day}`),
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
        this.redis.lrange(`${KEY_PREFIX}:durations:${day}`, 0, -1),
        this.redis.get(`${KEY_PREFIX}:bounces:${day}`),
      ]);

      const pvNum = parseInt(pv || '0', 10);
      const uniquesList = uniques || [];
      totalPageviews += pvNum;
      totalBounces += parseInt(bounces || '0', 10);
      uniquesList.forEach((u) => uniquesSet.add(u));

      timeSeries.push({ date: day, pageviews: pvNum, uniques: uniquesList.length });

      const merge = (acc: Record<string, number>, src?: Record<string, string> | null) => {
        Object.entries(src || {}).forEach(([k, v]) => { acc[k] = (acc[k] || 0) + parseInt(v, 10); });
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
      Object.entries(paths || {}).forEach(([k, v]) => { pathCounts[k] = (pathCounts[k] || 0) + parseInt(v, 10); });
      (durList || []).forEach((s) => { const n = parseInt(s, 10); if (!Number.isNaN(n)) durations.push(n); });
    }

    const topPages = Object.entries(pathCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([path, pageviews]) => ({ path, pageviews }));

    const avgDurationSeconds =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    const totalUniques = uniquesSet.size;
    const bounceRate = totalUniques > 0 ? (totalBounces / totalUniques) * 100 : 0;

    const today = this.dayKey(new Date());
    let activeToday = 0;
    if (days.includes(today)) {
      const u = await this.redis.smembers(`${KEY_PREFIX}:uniques:${today}`);
      activeToday = u?.length ?? 0;
    }

    // Map weekday numbers to names for display (0=Sun ... 6=Sat)
    const byWeekdayNamed: Record<string, number> = {};
    Object.entries(byWeekday).forEach(([k, v]) => {
      byWeekdayNamed[WEEKDAY_NAMES[k] ?? k] = v;
    });

    return {
      totalPageviews,
      totalUniques,
      activeToday,
      byCountry,
      byDevice,
      byBrowser,
      byOs,
      byReferrer,
      byUtmSource,
      byUtmMedium,
      byUtmCampaign,
      byHour,
      byWeekday: byWeekdayNamed,
      topPages,
      avgDurationSeconds,
      totalBounces,
      bounceRate,
      timeSeries,
      dateRange: { from: days[0] || from, to: days[days.length - 1] || to },
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
