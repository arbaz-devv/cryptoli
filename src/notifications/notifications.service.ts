import { Injectable } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SocketService } from '../socket/socket.service';
import { PushService } from './push.service';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socketService: SocketService,
    private readonly pushService: PushService,
  ) {}

  async listForUser(userId: string) {
    const [notifications, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      this.prisma.notification.count({
        where: { userId, read: false },
      }),
    ]);

    return { notifications, unreadCount };
  }

  async createForUser(input: {
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    link?: string;
  }) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        link: input.link,
      },
    });

    const unreadCount = await this.prisma.notification.count({
      where: { userId: input.userId, read: false },
    });

    this.socketService.emitNotificationCreated(input.userId, {
      notification,
      unreadCount,
    });

    this.pushService
      .sendToUser(input.userId, {
        title: input.title,
        body: input.message,
        url: input.link,
      })
      .catch(() => {});

    return notification;
  }

  async markRead(notificationId: string, userId: string) {
    const notification = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { read: true },
    });

    if (notification.count === 0) {
      const unreadCount = await this.prisma.notification.count({
        where: { userId, read: false },
      });
      return { success: false, unreadCount };
    }

    const unreadCount = await this.prisma.notification.count({
      where: { userId, read: false },
    });

    this.socketService.emitNotificationRead(userId, {
      notificationId,
      unreadCount,
    });

    return { success: true, unreadCount };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });

    this.socketService.emitNotificationsAllRead(userId, {
      unreadCount: 0,
    });

    return { success: true, unreadCount: 0 };
  }
}
