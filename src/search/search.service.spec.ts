import { SearchService } from './search.service';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import type { AnalyticsContext } from '../analytics/analytics-context';
import { RedisService } from '../redis/redis.service';
import { createRedisMock } from '../../test/helpers/redis.mock';
import { ObservabilityService } from '../observability/observability.service';

describe('SearchService', () => {
  let service: SearchService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let analyticsService: { track: jest.Mock };
  let redisService: ReturnType<typeof createRedisMock>;
  let observabilityService: {
    recordCacheHit: jest.Mock;
    recordCacheMiss: jest.Mock;
  };

  const mockCtx: AnalyticsContext = {
    ip: '1.2.3.4',
    userAgent: 'TestBrowser/1.0',
    country: 'US',
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    analyticsService = { track: jest.fn().mockResolvedValue(undefined) };
    redisService = createRedisMock(false);
    observabilityService = {
      recordCacheHit: jest.fn(),
      recordCacheMiss: jest.fn(),
    };
    service = new SearchService(
      prisma as unknown as PrismaService,
      redisService as unknown as RedisService,
      observabilityService as unknown as ObservabilityService,
      analyticsService as unknown as AnalyticsService,
    );
  });

  it('should return empty results for empty query', async () => {
    const result = await service.search('', 'all', 10);
    expect(result.results).toEqual({});
  });

  it('should return empty results for too-short query', async () => {
    const result = await service.search('a', 'all', 10);
    expect(result.results).toEqual({});
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('should search all entity types when type is "all"', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'c1', name: 'Bitcoin Exchange' }])
      .mockResolvedValueOnce([
        {
          id: 'r1',
          title: 'Bitcoin Review',
          content: 'content',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          helpfulCount: 5,
          downVoteCount: 1,
          overallScore: 4.5,
          verified: false,
          authorId: 'u1',
          authorUsername: 'satoshi',
          authorAvatar: null,
          companyId: 'c1',
          companyName: 'Bitcoin Exchange',
          companySlug: 'bitcoin-exchange',
        },
      ])
      .mockResolvedValueOnce([{ id: 'u1', username: 'bitcoinfan' }]);

    const result = await service.search('bitcoin', 'all', 10);

    expect(result.results.companies).toBeDefined();
    expect(result.results.reviews).toBeDefined();
    expect(result.results.users).toBeDefined();
  });

  it('should only search companies when type is "companies"', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    const result = await service.search('test', 'companies', 10);

    expect(result.results.companies).toBeDefined();
    expect(result.results.reviews).toBeUndefined();
    expect(result.results.users).toBeUndefined();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('should only search reviews when type is "reviews"', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    const result = await service.search('test', 'reviews', 10);

    expect(result.results.reviews).toBeDefined();
    expect(result.results.companies).toBeUndefined();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('should only search users when type is "users"', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    const result = await service.search('test', 'users', 10);

    expect(result.results.users).toBeDefined();
    expect(result.results.companies).toBeUndefined();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('should respect limit parameter', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await service.search('test', 'companies', 5);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  describe('analytics tracking', () => {
    it('should track search_performed with query, type, and resultCount', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { id: 'c1', name: 'Bitcoin Exchange' },
          { id: 'c2', name: 'Bitcoin Wallet' },
        ])
        .mockResolvedValueOnce([
          {
            id: 'r1',
            title: 'Bitcoin Review',
            content: 'content',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            helpfulCount: 0,
            downVoteCount: 0,
            overallScore: 4,
            verified: false,
            authorId: 'u1',
            authorUsername: 'user1',
            authorAvatar: null,
            companyId: null,
            companyName: null,
            companySlug: null,
          },
        ])
        .mockResolvedValueOnce([]);

      await service.search('bitcoin', 'all', 10, mockCtx, 'user-1');

      expect(analyticsService.track).toHaveBeenCalledWith(
        '1.2.3.4',
        'TestBrowser/1.0',
        {
          event: 'search_performed',
          consent: true,
          userId: 'user-1',
          properties: { query: 'bitcoin', type: 'all', resultCount: 3 },
        },
        'US',
      );
    });

    it('should track with undefined userId when user is not authenticated', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'c1' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.search('bitcoin', 'all', 10, mockCtx);

      expect(analyticsService.track).toHaveBeenCalledWith(
        '1.2.3.4',
        'TestBrowser/1.0',
        {
          event: 'search_performed',
          consent: true,
          userId: undefined,
          properties: { query: 'bitcoin', type: 'all', resultCount: 1 },
        },
        'US',
      );
    });

    it('should not track when analyticsCtx is absent', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await service.search('test', 'companies', 10);

      expect(analyticsService.track).not.toHaveBeenCalled();
    });

    it('should not track when analyticsService is absent', async () => {
      const serviceWithoutAnalytics = new SearchService(
        prisma as unknown as PrismaService,
        redisService as unknown as RedisService,
        observabilityService as unknown as ObservabilityService,
      );
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await serviceWithoutAnalytics.search('test', 'companies', 10, mockCtx);

      expect(analyticsService.track).not.toHaveBeenCalled();
    });

    it('should not track for empty query (early return)', async () => {
      await service.search('', 'all', 10, mockCtx);

      expect(analyticsService.track).not.toHaveBeenCalled();
    });
  });

  it('should return cached results when redis has a hit', async () => {
    redisService = createRedisMock(true);
    redisService._clientMock.get.mockResolvedValue(
      JSON.stringify({
        results: { companies: [{ id: 'cached-company' }] },
      }),
    );
    service = new SearchService(
      prisma as unknown as PrismaService,
      redisService as unknown as RedisService,
      observabilityService as unknown as ObservabilityService,
      analyticsService as unknown as AnalyticsService,
    );

    const result = await service.search('bitcoin', 'companies', 10);

    expect(result).toEqual({
      results: { companies: [{ id: 'cached-company' }] },
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(observabilityService.recordCacheHit).toHaveBeenCalledWith(
      'search.public',
    );
  });
});
