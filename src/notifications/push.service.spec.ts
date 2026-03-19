import { PushService } from './push.service';
import { PrismaService } from '../prisma/prisma.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';

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
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('onModuleInit()', () => {
    it('should not configure VAPID when keys are absent', () => {
      service.onModuleInit();
      // No error thrown = success (VAPID not configured)
      expect((service as any).vapidConfigured).toBe(false);
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
  });
});
