import { PushService } from './push.service';
import { PrismaService } from '../prisma/prisma.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import * as webPush from 'web-push';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

describe('PushService', () => {
  let service: PushService;
  let prisma: ReturnType<typeof createPrismaMock>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new PushService(prisma as unknown as PrismaService);
    // Ensure VAPID keys are not set
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('onModuleInit()', () => {
    it('should not configure VAPID when keys are absent', () => {
      service.onModuleInit();
      expect((service as any).vapidConfigured).toBe(false);
      expect(webPush.setVapidDetails).not.toHaveBeenCalled();
    });

    it('should configure VAPID when both keys are present', () => {
      process.env.VAPID_PUBLIC_KEY = 'test-public-key';
      process.env.VAPID_PRIVATE_KEY = 'test-private-key';

      service.onModuleInit();

      expect((service as any).vapidConfigured).toBe(true);
      expect(webPush.setVapidDetails).toHaveBeenCalledWith(
        'mailto:support@cryptoi.com',
        'test-public-key',
        'test-private-key',
      );
    });
  });

  describe('registerSubscription()', () => {
    it('should upsert subscription by endpoint', async () => {
      prisma.pushSubscription.upsert.mockResolvedValue({});

      await service.registerSubscription('u1', {
        endpoint: 'https://push.example.com/sub1',
        keys: { p256dh: 'key1', auth: 'auth1' },
      });

      expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith({
        where: { endpoint: 'https://push.example.com/sub1' },
        create: expect.objectContaining({
          userId: 'u1',
          endpoint: 'https://push.example.com/sub1',
        }),
        update: expect.objectContaining({
          userId: 'u1',
        }),
      });
    });
  });

  describe('sendToUser()', () => {
    it('should no-op when VAPID is not configured', async () => {
      service.onModuleInit(); // VAPID keys not set

      await service.sendToUser('u1', { title: 'Test', body: 'Hello' });

      expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
    });

    it('should send to all subscriptions when VAPID is configured', async () => {
      process.env.VAPID_PUBLIC_KEY = 'test-public-key';
      process.env.VAPID_PRIVATE_KEY = 'test-private-key';
      service.onModuleInit();

      const subs = [
        {
          id: 's1',
          userId: 'u1',
          endpoint: 'https://push.example.com/sub1',
          p256dh: 'k1',
          auth: 'a1',
          createdAt: new Date(),
        },
        {
          id: 's2',
          userId: 'u1',
          endpoint: 'https://push.example.com/sub2',
          p256dh: 'k2',
          auth: 'a2',
          createdAt: new Date(),
        },
      ];
      prisma.pushSubscription.findMany.mockResolvedValue(subs);
      (webPush.sendNotification as jest.Mock).mockResolvedValue({});

      await service.sendToUser('u1', { title: 'Test', body: 'Hello' });

      expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
      expect(webPush.sendNotification).toHaveBeenCalledTimes(2);
    });

    it('should delete stale subscriptions on 410 Gone', async () => {
      process.env.VAPID_PUBLIC_KEY = 'test-public-key';
      process.env.VAPID_PRIVATE_KEY = 'test-private-key';
      service.onModuleInit();

      const subs = [
        {
          id: 's1',
          userId: 'u1',
          endpoint: 'https://push.example.com/stale',
          p256dh: 'k1',
          auth: 'a1',
          createdAt: new Date(),
        },
      ];
      prisma.pushSubscription.findMany.mockResolvedValue(subs);
      prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });
      (webPush.sendNotification as jest.Mock).mockRejectedValue({
        statusCode: 410,
      });

      await service.sendToUser('u1', { title: 'Test', body: 'Gone' });

      // Wait for the fire-and-forget deleteMany
      await new Promise((r) => setTimeout(r, 50));

      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint: 'https://push.example.com/stale' },
      });
    });

    it('should delete stale subscriptions on 404 Not Found', async () => {
      process.env.VAPID_PUBLIC_KEY = 'test-public-key';
      process.env.VAPID_PRIVATE_KEY = 'test-private-key';
      service.onModuleInit();

      const subs = [
        {
          id: 's1',
          userId: 'u1',
          endpoint: 'https://push.example.com/gone',
          p256dh: 'k1',
          auth: 'a1',
          createdAt: new Date(),
        },
      ];
      prisma.pushSubscription.findMany.mockResolvedValue(subs);
      prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });
      (webPush.sendNotification as jest.Mock).mockRejectedValue({
        statusCode: 404,
      });

      await service.sendToUser('u1', { title: 'Test', body: 'Not found' });

      await new Promise((r) => setTimeout(r, 50));

      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint: 'https://push.example.com/gone' },
      });
    });
  });
});
