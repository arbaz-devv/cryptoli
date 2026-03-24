import { AnalyticsBufferService, BufferedEvent } from './analytics-buffer.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';

describe('AnalyticsBufferService', () => {
  let service: AnalyticsBufferService;
  let prisma: ReturnType<typeof createPrismaMock>;

  const makeEvent = (overrides: Partial<BufferedEvent> = {}): BufferedEvent => ({
    eventType: 'page_view',
    sessionId: 'test-session',
    ...overrides,
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.analyticsEvent.createMany.mockResolvedValue({ count: 0 });
    prisma.$executeRaw.mockResolvedValue(0);
    service = new AnalyticsBufferService(prisma as any);
  });

  afterEach(() => {
    // Ensure no lingering timers
    (service as any).flushTimer && clearInterval((service as any).flushTimer);
  });

  describe('push()', () => {
    it('should add event to buffer', () => {
      service.push(makeEvent());
      expect(service.bufferLength).toBe(1);
    });

    it('should drop events when buffer is full and log warning', () => {
      // Prevent threshold-triggered flushes from draining the buffer
      jest.spyOn(service, 'flush').mockResolvedValue();

      for (let i = 0; i < service.MAX_BUFFER; i++) {
        service.push(makeEvent({ eventType: `event_${i}` }));
      }
      expect(service.bufferLength).toBe(service.MAX_BUFFER);

      // Next push should be dropped
      const logSpy = jest.spyOn((service as any).logger, 'warn');
      service.push(makeEvent({ eventType: 'overflow_event' }));
      expect(service.bufferLength).toBe(service.MAX_BUFFER);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Buffer overflow'),
      );
    });

    it('should trigger flush when threshold is reached', async () => {
      const flushSpy = jest.spyOn(service, 'flush').mockResolvedValue();

      for (let i = 0; i < service.FLUSH_THRESHOLD; i++) {
        service.push(makeEvent());
      }

      expect(flushSpy).toHaveBeenCalled();
    });

    it('should not trigger flush below threshold', () => {
      const flushSpy = jest.spyOn(service, 'flush').mockResolvedValue();

      for (let i = 0; i < service.FLUSH_THRESHOLD - 1; i++) {
        service.push(makeEvent());
      }

      expect(flushSpy).not.toHaveBeenCalled();
    });
  });

  describe('flush()', () => {
    it('should no-op when buffer is empty', async () => {
      await service.flush();
      expect(prisma.analyticsEvent.createMany).not.toHaveBeenCalled();
    });

    it('should splice buffer before awaiting PG write', async () => {
      service.push(makeEvent());
      service.push(makeEvent({ eventType: 'click' }));

      const flushPromise = service.flush();
      // Buffer should be emptied immediately (splice before await)
      expect(service.bufferLength).toBe(0);

      await flushPromise;
      expect(prisma.analyticsEvent.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ eventType: 'page_view' }),
          expect.objectContaining({ eventType: 'click' }),
        ]),
      });
    });

    it('should set synchronous_commit off before createMany', async () => {
      service.push(makeEvent());
      await service.flush();

      const executeRawOrder = prisma.$executeRaw.mock.invocationCallOrder[0];
      const createManyOrder =
        prisma.analyticsEvent.createMany.mock.invocationCallOrder[0];
      expect(executeRawOrder).toBeLessThan(createManyOrder);
    });

    it('should log error and not re-queue on PG failure', async () => {
      const logSpy = jest.spyOn((service as any).logger, 'error');
      prisma.analyticsEvent.createMany.mockRejectedValueOnce(
        new Error('PG connection lost'),
      );

      service.push(makeEvent());
      await service.flush();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('PG connection lost'),
      );
      // Buffer should remain empty — events not re-queued
      expect(service.bufferLength).toBe(0);
    });

    it('should map event properties correctly including defaults', async () => {
      service.push(
        makeEvent({
          userId: 'u1',
          ipHash: 'hash123',
          country: 'US',
          device: 'mobile',
          browser: 'chrome',
          os: 'android',
          path: '/home',
          referrer: 'google.com',
          utmSource: 'newsletter',
          utmMedium: 'email',
          utmCampaign: 'launch',
          durationSeconds: 42,
          properties: { custom: 'data' },
        }),
      );
      await service.flush();

      const data = prisma.analyticsEvent.createMany.mock.calls[0][0].data;
      expect(data[0]).toMatchObject({
        eventType: 'page_view',
        userId: 'u1',
        ipHash: 'hash123',
        country: 'US',
        device: 'mobile',
        browser: 'chrome',
        os: 'android',
        path: '/home',
        referrer: 'google.com',
        utmSource: 'newsletter',
        utmMedium: 'email',
        utmCampaign: 'launch',
        durationSeconds: 42,
        properties: { custom: 'data' },
      });
      expect(data[0].createdAt).toBeInstanceOf(Date);
    });

    it('should default properties to empty object and createdAt to now', async () => {
      service.push(makeEvent());
      await service.flush();

      const data = prisma.analyticsEvent.createMany.mock.calls[0][0].data;
      expect(data[0].properties).toEqual({});
      expect(data[0].createdAt).toBeInstanceOf(Date);
    });
  });

  describe('onModuleInit()', () => {
    it('should start the flush timer', () => {
      service.onModuleInit();
      expect((service as any).flushTimer).not.toBeNull();
    });
  });

  describe('onModuleDestroy()', () => {
    it('should clear interval and drain buffer', async () => {
      service.onModuleInit();
      service.push(makeEvent());

      await service.onModuleDestroy();

      expect((service as any).flushTimer).toBeNull();
      expect(service.bufferLength).toBe(0);
      expect(prisma.analyticsEvent.createMany).toHaveBeenCalled();
    });

    it('should handle empty buffer on shutdown gracefully', async () => {
      await service.onModuleDestroy();
      expect(prisma.analyticsEvent.createMany).not.toHaveBeenCalled();
    });
  });
});
