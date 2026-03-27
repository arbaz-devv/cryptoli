import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AnalyticsBufferService } from './analytics-buffer.service';
import { AnalyticsRollupService } from './analytics-rollup.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsGuard } from './analytics.guard';
import { AnalyticsInterceptor } from './analytics.interceptor';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [PrismaModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsGuard,
    AnalyticsService,
    AnalyticsBufferService,
    AnalyticsRollupService,
    AnalyticsInterceptor,
  ],
  exports: [AnalyticsService, AnalyticsRollupService, AnalyticsInterceptor],
})
export class AnalyticsModule {}
