import { Controller, Get, Param, Post, Req, UseGuards, Body } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { SessionUser } from '../auth/auth.service';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';

@Controller('api/notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly pushService: PushService,
  ) {}

  @Get()
  list(@Req() req: Request & { user: SessionUser }) {
    return this.notificationsService.listForUser(req.user.id);
  }

  @Post('push-subscription')
  registerPushSubscription(
    @Req() req: Request & { user: SessionUser },
    @Body() body: { endpoint: string; keys: { p256dh: string; auth: string } },
  ) {
    if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
      return { success: false };
    }
    return this.pushService
      .registerSubscription(req.user.id, {
        endpoint: body.endpoint,
        keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
      })
      .then(() => ({ success: true }))
      .catch(() => ({ success: false }));
  }

  @Post('read-all')
  markAllRead(@Req() req: Request & { user: SessionUser }) {
    return this.notificationsService.markAllRead(req.user.id);
  }

  @Post(':id/read')
  markRead(
    @Param('id') id: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.notificationsService.markRead(id, req.user.id);
  }
}
