import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { SearchService } from './search.service';
import { AnalyticsInterceptor } from '../analytics/analytics.interceptor';

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
  ) {
    const parsedLimit = parseInt(limit, 10) || 10;
    const safeLimit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, parsedLimit));
    return this.searchService.search(q ?? '', type, safeLimit);
  }
}
