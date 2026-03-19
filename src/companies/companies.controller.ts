import { Controller, Get, Param, Query } from '@nestjs/common';
import { CompaniesService } from './companies.service';

const COMPANIES_LIST_LIMIT_MAX = 50;

@Controller('api/companies')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get()
  list(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('category') category?: string,
    @Query('search') search?: string,
  ) {
    const parsedPage = parseInt(page, 10) || 1;
    const parsedLimit = parseInt(limit, 10) || 20;
    const safePage = Math.max(1, parsedPage);
    const safeLimit = Math.min(
      COMPANIES_LIST_LIMIT_MAX,
      Math.max(1, parsedLimit),
    );

    return this.companiesService.list(safePage, safeLimit, category, search);
  }

  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.companiesService.getBySlug(slug);
  }
}
