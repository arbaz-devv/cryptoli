import { forwardRef, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { OptionalAuthGuard } from './optional-auth.guard';
import { AuthService } from './auth.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports: [forwardRef(() => NotificationsModule), AnalyticsModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, OptionalAuthGuard],
  exports: [AuthService, AuthGuard, OptionalAuthGuard],
})
export class AuthModule {}
