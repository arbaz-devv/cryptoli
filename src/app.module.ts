import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';
import { RedisModule } from './redis/redis.module';
import { RedisService } from './redis/redis.service';
import { RedisThrottlerStorage } from './redis/redis-throttler-storage';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ReviewsModule } from './reviews/reviews.module';
import { ComplaintsModule } from './complaints/complaints.module';
import { CommentsModule } from './comments/comments.module';
import { FeedModule } from './feed/feed.module';
import { SearchModule } from './search/search.module';
import { TrendingModule } from './trending/trending.module';
import { CompaniesModule } from './companies/companies.module';
import { SocketModule } from './socket/socket.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { UsersModule } from './users/users.module';
import { AdminModule } from './admin/admin.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReactionsModule } from './reactions/reactions.module';

@Module({
  imports: [
    ConfigModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      useFactory: (redis: RedisService) => ({
        throttlers: [
          { name: 'short', ttl: 60_000, limit: 10 },
          { name: 'long', ttl: 3600_000, limit: 500 },
        ],
        storage: new RedisThrottlerStorage(redis),
      }),
      inject: [RedisService],
    }),
    PrismaModule,
    AuthModule,
    SocketModule,
    ReviewsModule,
    ComplaintsModule,
    CommentsModule,
    FeedModule,
    SearchModule,
    TrendingModule,
    CompaniesModule,
    AnalyticsModule,
    UsersModule,
    AdminModule,
    NotificationsModule,
    ReactionsModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
