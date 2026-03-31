import { Injectable, OnModuleInit } from '@nestjs/common';
import * as webPush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

/** Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env for push. Generate with: npx web-push generate-vapid-keys */
@Injectable()
export class PushService implements OnModuleInit {
  private vapidConfigured = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (publicKey && privateKey) {
      webPush.setVapidDetails(
        'mailto:support@cryptoi.com',
        publicKey,
        privateKey,
      );
      this.vapidConfigured = true;
    }
  }

  async registerSubscription(
    userId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  ) {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: {
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
      update: {
        userId,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    });
  }

  async sendToUser(
    userId: string,
    payload: { title: string; body: string; url?: string },
    notificationId?: string,
  ) {
    if (!this.vapidConfigured) return;

    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId },
    });

    const payloadStr = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url ?? '/',
    });

    const results = await Promise.allSettled(
      subs.map((sub) =>
        webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payloadStr,
          { TTL: 60 * 60 * 24 },
        ),
      ),
    );

    let anySucceeded = false;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        anySucceeded = true;
      } else {
        const err = r.reason as { statusCode?: number };
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          void this.prisma.pushSubscription
            .deleteMany({ where: { endpoint: subs[i].endpoint } })
            .catch(() => {});
        }
      }
    });

    if (anySucceeded && notificationId) {
      void this.prisma.notification
        .update({
          where: { id: notificationId },
          data: { pushedAt: new Date() },
        })
        .catch(() => {});
    }
  }
}
