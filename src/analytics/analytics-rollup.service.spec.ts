import {
  AnalyticsRollupService,
  DaySnapshot,
} from './analytics-rollup.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import { createRedisMock } from '../../test/helpers/redis.mock';

describe('AnalyticsRollupService', () => {
  let service: AnalyticsRollupService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let redisMock: ReturnType<typeof createRedisMock>;

  const DAY = '2026-03-22';

  const makeSnapshot = (overrides: Partial<DaySnapshot> = {}): DaySnapshot => ({
    pageviews: 100,
    uniques: 50,
    sessions: 60,
    bounces: 10,
    likes: 5,
    durationSum: 3000,
    durationCount: 30,
    byCountry: { US: 60, DE: 40 },
    byDevice: { desktop: 70, mobile: 30 },
    byBrowser: { chrome: 80, firefox: 20 },
    byOs: { windows: 50, macos: 50 },
    byReferrer: { 'google.com': 40, direct: 60 },
    byUtmSource: {},
    byUtmMedium: {},
    byUtmCampaign: {},
    byHour: { '14': 30, '15': 70 },
    byWeekday: { '1': 100 },
    byPath: { '/': 60, '/about': 40 },
    byHourTz: {},
    durationHistogram: { '0_9': 10, '10_29': 20 },
    funnelEvents: { signup_started: 5 },
    funnelBySource: {},
    funnelByPath: {},
    ...overrides,
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    redisMock = createRedisMock(true);

    prisma.analyticsDailySummary.findFirst.mockResolvedValue(null);
    prisma.analyticsDailySummary.createMany.mockResolvedValue({ count: 0 });
    redisMock._clientMock.get.mockResolvedValue(null);
    redisMock._clientMock.set.mockResolvedValue('OK');

    service = new AnalyticsRollupService(prisma, redisMock as any);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('readDayFromRedis()', () => {
    it('should return empty snapshot when Redis is not ready', async () => {
      const notReadyMock = createRedisMock(false);
      const svc = new AnalyticsRollupService(prisma, notReadyMock as any);

      const snapshot = await svc.readDayFromRedis(DAY);
      expect(snapshot.pageviews).toBe(0);
      expect(snapshot.byCountry).toEqual({});
    });

    it('should read all 23 Redis keys and return parsed snapshot', async () => {
      const client = redisMock._clientMock;
      client.get.mockImplementation((key: string) => {
        if (key.includes('pageviews')) return Promise.resolve('150');
        if (key.includes('bounces')) return Promise.resolve('10');
        if (key.includes('duration_sum')) return Promise.resolve('5000');
        if (key.includes('duration_count')) return Promise.resolve('50');
        if (key.includes('like')) return Promise.resolve('7');
        return Promise.resolve(null);
      });
      client.hgetall.mockImplementation((key: string) => {
        if (key.includes('country'))
          return Promise.resolve({ US: '80', DE: '70' });
        if (key.includes('device')) return Promise.resolve({ desktop: '100' });
        return Promise.resolve({});
      });
      client.pfcount.mockImplementation((key: string) => {
        if (key.includes('uniques')) return Promise.resolve(90);
        if (key.includes('sessions')) return Promise.resolve(110);
        return Promise.resolve(0);
      });

      const snapshot = await service.readDayFromRedis(DAY);

      expect(snapshot.pageviews).toBe(150);
      expect(snapshot.uniques).toBe(90);
      expect(snapshot.sessions).toBe(110);
      expect(snapshot.bounces).toBe(10);
      expect(snapshot.likes).toBe(7);
      expect(snapshot.durationSum).toBe(5000);
      expect(snapshot.durationCount).toBe(50);
      expect(snapshot.byCountry).toEqual({ US: 80, DE: 70 });
      expect(snapshot.byDevice).toEqual({ desktop: 100 });
    });

    it('should handle null Redis values gracefully', async () => {
      redisMock._clientMock.get.mockResolvedValue(null);
      redisMock._clientMock.hgetall.mockResolvedValue({});
      redisMock._clientMock.pfcount.mockResolvedValue(0);

      const snapshot = await service.readDayFromRedis(DAY);

      expect(snapshot.pageviews).toBe(0);
      expect(snapshot.uniques).toBe(0);
      expect(snapshot.sessions).toBe(0);
    });
  });

  describe('rollupDay()', () => {
    beforeEach(() => {
      // Default: readDayFromRedis returns data with pageviews > 0
      jest.spyOn(service, 'readDayFromRedis').mockResolvedValue(makeSnapshot());
    });

    it('should skip when NX lock exists in Redis', async () => {
      redisMock._clientMock.get.mockResolvedValue('1');

      const result = await service.rollupDay(DAY);

      expect(result).toBe(false);
      expect(prisma.analyticsDailySummary.findFirst).not.toHaveBeenCalled();
    });

    it('should skip when PG already has rows for the day (idempotency)', async () => {
      redisMock._clientMock.get.mockResolvedValue(null); // no NX lock
      prisma.analyticsDailySummary.findFirst.mockResolvedValue({
        id: 'existing',
      });

      const result = await service.rollupDay(DAY);

      expect(result).toBe(false);
      expect(service.readDayFromRedis).not.toHaveBeenCalled();
    });

    it('should skip when pageviews is zero (Redis down or keys expired)', async () => {
      jest
        .spyOn(service, 'readDayFromRedis')
        .mockResolvedValue(makeSnapshot({ pageviews: 0 }));

      const result = await service.rollupDay(DAY);

      expect(result).toBe(false);
      expect(prisma.analyticsDailySummary.createMany).not.toHaveBeenCalled();
    });

    it('should write rows to PG and set NX lock on success', async () => {
      const result = await service.rollupDay(DAY);

      expect(result).toBe(true);
      expect(prisma.analyticsDailySummary.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            dimension: '_total_',
            dimensionValue: 'pageviews',
            count: 100,
          }),
          expect.objectContaining({
            dimension: 'country',
            dimensionValue: 'US',
            count: 60,
          }),
        ]),
        skipDuplicates: true,
      });

      // NX lock set after PG write
      expect(redisMock._clientMock.set).toHaveBeenCalledWith(
        `analytics:rollup:last:${DAY}`,
        '1',
        'EX',
        172800,
        'NX',
      );
    });

    it('should set NX lock AFTER PG write (not before)', async () => {
      await service.rollupDay(DAY);

      const createManyOrder =
        prisma.analyticsDailySummary.createMany.mock.invocationCallOrder[0];

      // Find the NX lock set call specifically
      const setCalls = redisMock._clientMock.set.mock.calls;
      const nxCallIndex = setCalls.findIndex(
        (call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('rollup:last:'),
      );
      expect(nxCallIndex).toBeGreaterThanOrEqual(0);

      const setNxOrder =
        redisMock._clientMock.set.mock.invocationCallOrder[nxCallIndex];
      expect(createManyOrder).toBeLessThan(setNxOrder);
    });

    it('should handle PG unique constraint violation (P2002) gracefully', async () => {
      const error = new Error('Unique constraint failed');
      (error as any).code = 'P2002';
      prisma.analyticsDailySummary.createMany.mockRejectedValueOnce(error);

      const result = await service.rollupDay(DAY);

      // Should not throw, treats as success (concurrent rollup)
      expect(result).toBe(true);
    });

    it('should rethrow non-P2002 PG errors', async () => {
      prisma.analyticsDailySummary.createMany.mockRejectedValueOnce(
        new Error('Connection timeout'),
      );

      await expect(service.rollupDay(DAY)).rejects.toThrow(
        'Connection timeout',
      );
    });

    it('should produce correct EAV rows from snapshot', async () => {
      const snapshot = makeSnapshot({
        pageviews: 200,
        uniques: 100,
        sessions: 120,
        bounces: 20,
        likes: 10,
        durationSum: 6000,
        durationCount: 60,
        byCountry: { US: 120, DE: 80 },
        byDevice: { desktop: 140, mobile: 60 },
        durationHistogram: { '0_9': 30, '10_29': 30 },
        funnelEvents: { signup_started: 10, signup_completed: 5 },
      });
      jest.spyOn(service, 'readDayFromRedis').mockResolvedValue(snapshot);

      await service.rollupDay(DAY);

      const rows =
        prisma.analyticsDailySummary.createMany.mock.calls[0][0].data;

      // Verify scalar rows
      expect(rows).toContainEqual(
        expect.objectContaining({
          dimension: '_total_',
          dimensionValue: 'pageviews',
          count: 200,
        }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          dimension: '_total_',
          dimensionValue: 'uniques_approx',
          count: 100,
        }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          dimension: '_total_',
          dimensionValue: 'sessions_approx',
          count: 120,
        }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          dimension: '_total_',
          dimensionValue: 'bounces',
          count: 20,
        }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          dimension: '_total_',
          dimensionValue: 'likes',
          count: 10,
        }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          dimension: '_total_',
          dimensionValue: 'duration_sum',
          count: 6000,
        }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          dimension: '_total_',
          dimensionValue: 'duration_count',
          count: 60,
        }),
      );

      // Verify hash rows
      expect(rows).toContainEqual(
        expect.objectContaining({
          dimension: 'country',
          dimensionValue: 'US',
          count: 120,
        }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          dimension: 'duration_bucket',
          dimensionValue: '0_9',
          count: 30,
        }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          dimension: 'funnel_event',
          dimensionValue: 'signup_started',
          count: 10,
        }),
      );
    });

    it('should omit zero-value entries from rows', async () => {
      const snapshot = makeSnapshot({
        likes: 0,
        byUtmSource: { google: 10, empty: 0 },
      });
      jest.spyOn(service, 'readDayFromRedis').mockResolvedValue(snapshot);

      await service.rollupDay(DAY);

      const rows =
        prisma.analyticsDailySummary.createMany.mock.calls[0][0].data;
      const likeRow = rows.find(
        (r: { dimensionValue: string }) => r.dimensionValue === 'likes',
      );
      expect(likeRow).toBeUndefined();

      const emptyUtm = rows.find(
        (r: { dimensionValue: string }) => r.dimensionValue === 'empty',
      );
      expect(emptyUtm).toBeUndefined();
    });
  });

  describe('checkAndRollup()', () => {
    it('should check 32 days on first run (startup backfill)', async () => {
      const rollupSpy = jest
        .spyOn(service, 'rollupDay')
        .mockResolvedValue(false);

      await (service as any).checkAndRollup();

      expect(rollupSpy).toHaveBeenCalledTimes(32);
    });

    it('should check only 2 days on subsequent runs', async () => {
      const rollupSpy = jest
        .spyOn(service, 'rollupDay')
        .mockResolvedValue(false);

      await (service as any).checkAndRollup();
      rollupSpy.mockClear();

      await (service as any).checkAndRollup();

      expect(rollupSpy).toHaveBeenCalledTimes(2);
    });

    it('should record last_success in Redis when a day is rolled up', async () => {
      jest.spyOn(service, 'rollupDay').mockResolvedValue(true);

      await (service as any).checkAndRollup();

      expect(redisMock._clientMock.set).toHaveBeenCalledWith(
        'analytics:rollup:last_success',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      );
    });

    it('should continue processing after a single day rollup failure', async () => {
      const rollupSpy = jest
        .spyOn(service, 'rollupDay')
        .mockRejectedValueOnce(new Error('PG down'))
        .mockResolvedValue(false);

      await (service as any).checkAndRollup();

      // Should have attempted all 32 days despite first failure
      expect(rollupSpy).toHaveBeenCalledTimes(32);
    });
  });

  describe('lifecycle', () => {
    it('onModuleInit should schedule timers', () => {
      service.onModuleInit();

      expect((service as any).timer).not.toBeNull();
      expect((service as any).initialTimer).not.toBeNull();
    });

    it('onModuleDestroy should clear all timers', () => {
      service.onModuleInit();
      service.onModuleDestroy();

      expect((service as any).timer).toBeNull();
      expect((service as any).initialTimer).toBeNull();
    });
  });
});
