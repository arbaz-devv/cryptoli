import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SocketModule } from '../socket/socket.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [AuthModule, NotificationsModule, SocketModule, AnalyticsModule],
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}
