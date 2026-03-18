import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AdminGuard } from '../admin/admin.guard';
import { SessionUser } from '../auth/auth.service';
import { ComplaintsService } from './complaints.service';

const COMPLAINTS_LIST_LIMIT_MAX = 50;

@Controller('api/complaints')
export class ComplaintsController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  @Get()
  @UseGuards(OptionalAuthGuard)
  list(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('companyId') companyId?: string,
    @Query('userId') userId?: string,
    @Query('username') username?: string,
    @Req() req?: Request & { user?: SessionUser | null },
  ) {
    const parsedPage = parseInt(page, 10) || 1;
    const parsedLimit = parseInt(limit, 10) || 20;
    const safePage = Math.max(1, parsedPage);
    const safeLimit = Math.min(
      COMPLAINTS_LIST_LIMIT_MAX,
      Math.max(1, parsedLimit),
    );

    return this.complaintsService.list(
      safePage,
      safeLimit,
      companyId,
      userId,
      username,
      req?.user ?? null,
    );
  }

  @Post()
  @UseGuards(AuthGuard)
  create(@Body() body: unknown, @Req() req: Request & { user: SessionUser }) {
    return this.complaintsService.create(body, req.user.id);
  }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  getById(
    @Param('id') id: string,
    @Req() req?: Request & { user?: SessionUser | null },
  ) {
    return this.complaintsService.getById(id, req?.user ?? null);
  }

  @Post(':id/vote')
  @UseGuards(AuthGuard)
  vote(
    @Param('id') id: string,
    @Body() body: { voteType: string },
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.complaintsService.vote(id, body.voteType, req.user.id);
  }

  @Post(':id/reply')
  @UseGuards(AdminGuard)
  reply(@Param('id') id: string, @Body() body: { content: string }) {
    return this.complaintsService.reply(id, body.content);
  }
}
