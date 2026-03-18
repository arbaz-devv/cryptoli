import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';
import { TrackDto } from './dto/track.dto';

function firstHeader(req: Request, name: string): string {
  const value = req.headers[name];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && value[0]) return value[0].trim();
  return '';
}

function normalizeIp(candidate: string): string {
  const ip = (candidate || '').trim();
  if (!ip) return '';

  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed?.[1]) {
    const clean = bracketed[1].replace(/^::ffff:/i, '').split('%')[0];
    return isIP(clean) ? clean : '';
  }

  const ipv4WithPort = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort?.[1]) return isIP(ipv4WithPort[1]) ? ipv4WithPort[1] : '';

  const clean = ip.replace(/^::ffff:/i, '').split('%')[0];
  return isIP(clean) ? clean : '';
}

function isPrivateOrLocalIp(ip: string): boolean {
  if (!ip || ip === '::1') return true;
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  const v6 = ip.toLowerCase();
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
  if (v6.startsWith('fe80:')) return true;
  return false;
}

function pickBestIp(rawValues: string[]): string {
  const normalized = rawValues.map(normalizeIp).filter(Boolean);
  const firstPublic = normalized.find((ip) => !isPrivateOrLocalIp(ip));
  return firstPublic || normalized[0] || '';
}

function parseForwardedHeader(value: string): string[] {
  // RFC 7239: Forwarded: for=203.0.113.10;proto=https, for="[2001:db8::1]"
  return value
    .split(',')
    .map((part) => {
      const match = part.match(/for=("?\[?[a-fA-F0-9:.%]+\]?"?)/i);
      if (!match?.[1]) return '';
      return match[1].replace(/^"|"$|^'|'$/g, '');
    })
    .filter(Boolean);
}

function getClientIp(req: Request): string {
  const directHeaders = [
    'cf-connecting-ip',
    'x-real-ip',
    'x-client-ip',
    'true-client-ip',
    'fastly-client-ip',
  ];
  for (const header of directHeaders) {
    const ip = normalizeIp(firstHeader(req, header));
    if (ip) return ip;
  }

  const forwardedHeaders = ['x-forwarded-for', 'x-vercel-forwarded-for'];
  for (const header of forwardedHeaders) {
    const value = firstHeader(req, header);
    if (!value) continue;
    const best = pickBestIp(
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part && part.toLowerCase() !== 'unknown'),
    );
    if (best) return best;
  }

  const forwarded = firstHeader(req, 'forwarded');
  if (forwarded) {
    const best = pickBestIp(parseForwardedHeader(forwarded));
    if (best) return best;
  }

  return normalizeIp(req.socket?.remoteAddress || req.ip || '');
}

function getCountryHint(req: Request): string | undefined {
  const headerNames = [
    'cf-ipcountry',
    'x-vercel-ip-country',
    'cloudfront-viewer-country',
    'x-appengine-country',
    'x-country-code',
  ];
  for (const header of headerNames) {
    const value = firstHeader(req, header).toUpperCase();
    if (/^[A-Z]{2}$/.test(value)) return value;
  }
  return undefined;
}

@Controller('api/analytics')
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Higher throttle limit: many page_view/page_leave/funnel events per session. */
  @Throttle({
    short: { limit: 300, ttl: 60_000 },
    long: { limit: 600, ttl: 60_000 },
  })
  @Post('track')
  track(@Req() req: Request, @Body() body: TrackDto): { ok: boolean } {
    const ip = getClientIp(req);
    const countryHint = getCountryHint(req);
    const userAgent =
      (req.headers['user-agent'] as string) || body.device || '';
    void this.analyticsService.track(ip, userAgent, body, countryHint);
    return { ok: true };
  }

  @Get('stats')
  async stats(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('key') key?: string,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const apiKey = process.env.ANALYTICS_API_KEY;
    if (apiKey && apiKey.length > 0 && key !== apiKey) {
      return { ok: false, error: 'Unauthorized' };
    }
    const fromDate =
      from ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    const toDate = to || new Date().toISOString().slice(0, 10);
    const data = await this.analyticsService.getStats(fromDate, toDate);
    if (data === null) {
      return { ok: false, error: 'Analytics not available (Redis required)' };
    }
    try {
      const fromD = new Date(fromDate);
      fromD.setUTCHours(0, 0, 0, 0);
      const toD = new Date(toDate);
      toD.setUTCHours(23, 59, 59, 999);
      data.newMembersInRange = await this.prisma.user.count({
        where: { createdAt: { gte: fromD, lte: toD } },
      });
    } catch {
      data.newMembersInRange = 0;
    }
    return { ok: true, data };
  }

  @Get('health')
  async health(): Promise<{
    enabled: boolean;
    configured: boolean;
    connected: boolean;
    lastError: string | null;
  }> {
    const enabled = await this.analyticsService.isHealthy();
    return {
      enabled,
      ...this.analyticsService.getHealthDetails(),
    };
  }

  @Get('realtime')
  async realtime(@Query('key') key?: string): Promise<{
    ok: boolean;
    activeNow?: number;
    byCountry?: Record<string, number>;
    error?: string;
  }> {
    const apiKey = process.env.ANALYTICS_API_KEY;
    if (apiKey && apiKey.length > 0 && key !== apiKey) {
      return { ok: false, error: 'Unauthorized' };
    }
    const data = await this.analyticsService.getRealtime();
    return { ok: true, activeNow: data.activeNow, byCountry: data.byCountry };
  }

  /** Latest registered users (real data from DB) for admin analytics dashboard */
  @Get('latest-members')
  async latestMembers(
    @Query('limit') limit = '8',
    @Query('key') key?: string,
  ): Promise<{
    ok: boolean;
    members?: { id: string; name: string; date: string }[];
    error?: string;
  }> {
    const apiKey = process.env.ANALYTICS_API_KEY;
    if (apiKey && apiKey.length > 0 && key !== apiKey) {
      return { ok: false, error: 'Unauthorized' };
    }
    const take = Math.min(20, Math.max(1, parseInt(limit, 10) || 8));
    try {
      const users = await this.prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, name: true, username: true, createdAt: true },
      });
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);
      const members = users.map((u) => {
        const d = u.createdAt.toISOString().slice(0, 10);
        let date: string;
        if (d === today) date = 'Today';
        else if (d === yesterdayStr) date = 'Yesterday';
        else
          date = u.createdAt.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          });
        return {
          id: u.id,
          name: u.name || u.username || 'User',
          date,
        };
      });
      return { ok: true, members };
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Failed to fetch latest members';
      return { ok: false, error: message };
    }
  }
}
