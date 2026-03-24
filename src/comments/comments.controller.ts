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
import { CommentsService } from './comments.service';
import { AnalyticsInterceptor } from '../analytics/analytics.interceptor';

@UseInterceptors(AnalyticsInterceptor)
@Controller('api/comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get()
  @UseGuards(OptionalAuthGuard)
  listByQuery(
    @Query('reviewId') reviewId?: string,
    @Query('postId') postId?: string,
    @Query('complaintId') complaintId?: string,
    @Req() req?: Request & { user?: SessionUser | null },
  ) {
    return this.commentsService.list(
      reviewId,
      postId,
      complaintId,
      req?.user ?? null,
    );
  }

  @Post()
  @UseGuards(AuthGuard)
  create(@Body() body: unknown, @Req() req: Request & { user: SessionUser }) {
    return this.commentsService.create(
      body,
      req.user.id,
      (req as any).analyticsCtx,
    );
  }

  @Get('list')
  @UseGuards(OptionalAuthGuard)
  list(
    @Query('reviewId') reviewId?: string,
    @Query('postId') postId?: string,
    @Query('complaintId') complaintId?: string,
    @Req() req?: Request & { user?: SessionUser | null },
  ) {
    return this.commentsService.list(
      reviewId,
      postId,
      complaintId,
      req?.user ?? null,
    );
  }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  getById(
    @Param('id') id: string,
    @Query('reviewId') reviewId?: string,
    @Query('postId') postId?: string,
    @Query('complaintId') complaintId?: string,
    @Req() req?: Request & { user?: SessionUser | null },
  ) {
    return this.commentsService.getById(
      id,
      reviewId,
      postId,
      complaintId,
      req?.user ?? null,
    );
  }

  @Post(':id/vote')
  @UseGuards(AuthGuard)
  vote(
    @Param('id') id: string,
    @Body() body: { voteType: string },
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.commentsService.vote(
      id,
      body.voteType,
      req.user.id,
      (req as any).analyticsCtx,
    );
  }
}
