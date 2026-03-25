import { Controller, Get, Query, Req, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { SearchService } from './search.service';
import { AnalyticsInterceptor } from '../analytics/analytics.interceptor';
import { getAnalyticsCtx } from '../analytics/analytics-context';

const SEARCH_LIMIT_MAX = 50;

@UseInterceptors(AnalyticsInterceptor)
@Controller('api/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  search(
    @Query('q') q?: string,
    @Query('type') type = 'all',
    @Query('limit') limit = '10',
    @Req() req?: Request,
  ) {
    const parsedLimit = parseInt(limit, 10) || 10;
    const safeLimit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, parsedLimit));
    return this.searchService.search(
      q ?? '',
      type,
      safeLimit,
      req ? getAnalyticsCtx(req) : undefined,
    );
  }
}
