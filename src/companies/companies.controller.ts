import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import type { SessionUser } from '../auth/auth.service';
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
  @UseGuards(OptionalAuthGuard)
  getBySlug(
    @Param('slug') slug: string,
    @Req() req?: Request & { user?: SessionUser | null },
  ) {
    const viewerId = req?.user?.id ?? null;
    return this.companiesService.getBySlug(slug, viewerId);
  }

  @Post(':slug/follow')
  @UseGuards(AuthGuard)
  follow(
    @Param('slug') slug: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.companiesService.followCompany(req.user.id, slug);
  }

  @Delete(':slug/follow')
  @UseGuards(AuthGuard)
  unfollow(
    @Param('slug') slug: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.companiesService.unfollowCompany(req.user.id, slug);
  }
}
