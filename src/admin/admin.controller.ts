import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Header,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import {
  AdminLazyQueryDto,
  ComplaintsQueryDto,
  PageLimitDto,
  UpdateComplaintStatusDto,
  UpdateReviewStatusDto,
  UpdateUserStatusDto,
  ReviewsQueryDto,
  UsersQueryDto,
  SessionsQueryDto,
  SessionsExportQueryDto,
  ExportFormat,
  RollupDto,
} from './dto';

@Controller('api/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('stats')
  async stats() {
    return this.admin.getStats();
  }

  @Get('users')
  async users(@Query() query: UsersQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    return this.admin.getUsers({
      page,
      limit,
      q: query.q,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      status: query.status,
    });
  }

  @Get('users/:id')
  async userDetail(@Param('id') id: string, @Query() query: AdminLazyQueryDto) {
    return this.admin.getUserDetail(id, query.lazy ?? false);
  }

  @Get('users/:id/sessions')
  async userSessions(
    @Param('id') id: string,
    @Query() query: SessionsQueryDto,
  ) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    return this.admin.getUserSessions(id, page, limit);
  }

  @Get('users/:id/sessions/export')
  @Header('Cache-Control', 'no-store')
  async userSessionsExport(
    @Param('id') id: string,
    @Query() query: SessionsExportQueryDto,
  ) {
    const data = await this.admin.getUserSessionsExport(id, query.format);

    if (query.format === ExportFormat.CSV) {
      const buffer = Buffer.from(data as string, 'utf-8');
      return new StreamableFile(buffer, {
        type: 'text/csv; charset=utf-8',
        disposition: `attachment; filename="sessions-${id}.csv"`,
      });
    }

    return data;
  }

  @Get('users/:id/activity')
  async userActivity(@Param('id') id: string, @Query() query: PageLimitDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    return this.admin.getUserActivity(id, page, limit);
  }

  @Patch('users/:id/status')
  async updateUserStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.admin.updateUserStatus(id, dto.status, dto.reason);
  }

  @Get('complaints')
  async complaints(@Query() query: ComplaintsQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    return this.admin.getComplaints({
      page,
      limit,
      q: query.q,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      status: query.status,
    });
  }

  @Get('complaints/:id')
  async getComplaint(@Param('id') id: string) {
    return this.admin.getComplaint(id);
  }

  @Patch('complaints/:id')
  async updateComplaintStatus(
    @Param('id') id: string,
    @Body() dto: UpdateComplaintStatusDto,
  ) {
    return this.admin.updateComplaintStatus(id, dto.status);
  }

  @Get('reviews')
  async reviews(@Query() query: ReviewsQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    return this.admin.getReviews({
      page,
      limit,
      includeTotal: query.includeTotal ?? true,
      status: query.status,
      q: query.q,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  }

  @Get('reviews/:id')
  async getReview(@Param('id') id: string, @Query() query: AdminLazyQueryDto) {
    return this.admin.getReview(id, query.lazy ?? false);
  }

  @Patch('reviews/:id')
  async updateReviewStatus(
    @Param('id') id: string,
    @Body() dto: UpdateReviewStatusDto,
  ) {
    return this.admin.updateReviewStatus(id, dto.status);
  }

  @Get('ratings')
  async ratings(@Query() query: PageLimitDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    return this.admin.getRatings({ page, limit });
  }

  @Post('analytics/rollup')
  async rollup(@Body() dto: RollupDto) {
    return this.admin.rollupAnalytics({
      date: dto.date,
      from: dto.from,
      to: dto.to,
    });
  }
}
