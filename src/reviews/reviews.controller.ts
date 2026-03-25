import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { SessionUser } from '../auth/auth.service';
import { ReviewsService } from './reviews.service';
import { AnalyticsInterceptor } from '../analytics/analytics.interceptor';
import { getAnalyticsCtx } from '../analytics/analytics-context';

const REVIEW_LIST_LIMIT_MAX = 50;

@UseInterceptors(AnalyticsInterceptor)
@Controller('api/reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get()
  @UseGuards(OptionalAuthGuard)
  list(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('category') category?: string,
    @Query('companyId') companyId?: string,
    @Query('username') username?: string,
    @Query('status') status = 'APPROVED',
    @Req() req?: Request & { user?: SessionUser | null },
  ) {
    const parsedPage = parseInt(page, 10) || 1;
    const parsedLimit = parseInt(limit, 10) || 20;
    const safePage = Math.max(1, parsedPage);
    const safeLimit = Math.min(REVIEW_LIST_LIMIT_MAX, Math.max(1, parsedLimit));
    const safeStatus = 'APPROVED';
    void status;

    return this.reviewsService.list(
      safePage,
      safeLimit,
      category,
      companyId,
      username?.trim() || undefined,
      safeStatus,
      req?.user ?? null,
    );
  }

  @Post()
  @UseGuards(AuthGuard)
  create(@Body() body: unknown, @Req() req: Request & { user: SessionUser }) {
    return this.reviewsService.create(body, req.user.id, getAnalyticsCtx(req));
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.reviewsService.getById(id);
  }

  @Post(':id/vote')
  @UseGuards(AuthGuard)
  vote(
    @Param('id') id: string,
    @Body() body: { voteType: string },
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.reviewsService.vote(
      id,
      body.voteType,
      req.user.id,
      getAnalyticsCtx(req),
    );
  }

  @Post(':id/helpful')
  @UseGuards(AuthGuard)
  helpful(
    @Param('id') id: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.reviewsService.helpful(id, req.user.id, getAnalyticsCtx(req));
  }
}
