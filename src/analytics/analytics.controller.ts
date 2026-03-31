import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import {
  AnalyticsService,
  EventAggregationResult,
  NotificationAnalyticsResult,
  SearchQueryAnalyticsResult,
} from './analytics.service';
import { AnalyticsGuard } from './analytics.guard';
import { TrackDto } from './dto/track.dto';
import { getClientIp, getCountryHint } from './ip-utils';
import { AnalyticsInterceptor } from './analytics.interceptor';

@UseInterceptors(AnalyticsInterceptor)
@Controller('api/analytics')
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

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

  @UseGuards(AnalyticsGuard)
  @Get('stats')
  async stats(
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
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

  @UseGuards(AnalyticsGuard)
  @Get('health')
  async health(): Promise<{
    enabled: boolean;
    configured: boolean;
    connected: boolean;
    lastError: string | null;
    rollup: { lastSuccessDate: string | null; stale: boolean };
  }> {
    const [enabled, rollup] = await Promise.all([
      this.analyticsService.isHealthy(),
      this.analyticsService.getRollupHealth(),
    ]);
    return {
      enabled,
      ...this.analyticsService.getHealthDetails(),
      rollup,
    };
  }

  @UseGuards(AnalyticsGuard)
  @Get('realtime')
  async realtime(): Promise<{
    ok: boolean;
    activeNow?: number;
    byCountry?: Record<string, number>;
    error?: string;
  }> {
    const data = await this.analyticsService.getRealtime();
    return { ok: true, activeNow: data.activeNow, byCountry: data.byCountry };
  }

  /** Event aggregation: daily timeseries + dimensional breakdowns from analytics_events table */
  @UseGuards(AnalyticsGuard)
  @Get('events')
  async events(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('eventType') eventType?: string,
  ): Promise<{ ok: boolean; data?: EventAggregationResult; error?: string }> {
    const fromDate =
      from ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    const toDate = to || new Date().toISOString().slice(0, 10);
    try {
      const data = await this.analyticsService.getEventAggregation(
        fromDate,
        toDate,
        eventType || undefined,
      );
      return { ok: true, data };
    } catch (e) {
      this.logger.error(
        'Failed to fetch event aggregation',
        e instanceof Error ? e.stack : e,
      );
      return { ok: false, error: 'Failed to fetch event aggregation' };
    }
  }

  /** Notification analytics: read rates, push delivery rates, grouped by type */
  @UseGuards(AnalyticsGuard)
  @Get('notifications')
  async notifications(
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<{
    ok: boolean;
    data?: NotificationAnalyticsResult;
    error?: string;
  }> {
    const fromDate =
      from ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    const toDate = to || new Date().toISOString().slice(0, 10);
    try {
      const data = await this.analyticsService.getNotificationAnalytics(
        fromDate,
        toDate,
      );
      return { ok: true, data };
    } catch (e) {
      this.logger.error(
        'Failed to fetch notification analytics',
        e instanceof Error ? e.stack : e,
      );
      return { ok: false, error: 'Failed to fetch notification analytics' };
    }
  }

  /** Search query analytics: top queries, volume trends, type breakdown from analytics_events */
  @UseGuards(AnalyticsGuard)
  @Get('search-queries')
  async searchQueries(
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<{
    ok: boolean;
    data?: SearchQueryAnalyticsResult;
    error?: string;
  }> {
    const fromDate =
      from ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    const toDate = to || new Date().toISOString().slice(0, 10);
    try {
      const data = await this.analyticsService.getSearchQueryAnalytics(
        fromDate,
        toDate,
      );
      return { ok: true, data };
    } catch (e) {
      this.logger.error(
        'Failed to fetch search query analytics',
        e instanceof Error ? e.stack : e,
      );
      return { ok: false, error: 'Failed to fetch search query analytics' };
    }
  }

  /** Latest registered users (real data from DB) for admin analytics dashboard */
  @UseGuards(AnalyticsGuard)
  @Get('latest-members')
  async latestMembers(@Query('limit') limit = '8'): Promise<{
    ok: boolean;
    members?: { id: string; name: string; date: string }[];
    error?: string;
  }> {
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
      this.logger.error('Failed to fetch latest members', e instanceof Error ? e.stack : e);
      return { ok: false, error: 'Failed to fetch latest members' };
    }
  }
}
