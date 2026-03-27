import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [AnalyticsModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
