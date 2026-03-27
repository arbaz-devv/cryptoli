import { SearchService } from './search.service';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import type { AnalyticsContext } from '../analytics/analytics-context';

describe('SearchService', () => {
  let service: SearchService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let analyticsService: { track: jest.Mock };

  const mockCtx: AnalyticsContext = {
    ip: '1.2.3.4',
    userAgent: 'TestBrowser/1.0',
    country: 'US',
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    analyticsService = { track: jest.fn().mockResolvedValue(undefined) };
    service = new SearchService(
      prisma as unknown as PrismaService,
      analyticsService as unknown as AnalyticsService,
    );
  });

  it('should return empty results for empty query', async () => {
    const result = await service.search('', 'all', 10);
    expect(result.results).toEqual({});
  });

  it('should search all entity types when type is "all"', async () => {
    prisma.company.findMany.mockResolvedValue([
      { id: 'c1', name: 'Bitcoin Exchange' },
    ]);
    prisma.review.findMany.mockResolvedValue([
      { id: 'r1', title: 'Bitcoin Review' },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', username: 'bitcoinfan' },
    ]);

    const result = await service.search('bitcoin', 'all', 10);

    expect(result.results.companies).toBeDefined();
    expect(result.results.reviews).toBeDefined();
    expect(result.results.users).toBeDefined();
  });

  it('should only search companies when type is "companies"', async () => {
    prisma.company.findMany.mockResolvedValue([]);

    const result = await service.search('test', 'companies', 10);

    expect(result.results.companies).toBeDefined();
    expect(result.results.reviews).toBeUndefined();
    expect(result.results.users).toBeUndefined();
  });

  it('should only search reviews when type is "reviews"', async () => {
    prisma.review.findMany.mockResolvedValue([]);

    const result = await service.search('test', 'reviews', 10);

    expect(result.results.reviews).toBeDefined();
    expect(result.results.companies).toBeUndefined();
  });

  it('should only search users when type is "users"', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    const result = await service.search('test', 'users', 10);

    expect(result.results.users).toBeDefined();
    expect(result.results.companies).toBeUndefined();
  });

  it('should respect limit parameter', async () => {
    prisma.company.findMany.mockResolvedValue([]);

    await service.search('test', 'companies', 5);

    const findCall = prisma.company.findMany.mock.calls[0][0];
    expect(findCall.take).toBe(5);
  });

  describe('analytics tracking', () => {
    it('should track search_performed with query, type, and resultCount', async () => {
      prisma.company.findMany.mockResolvedValue([
        { id: 'c1', name: 'Bitcoin Exchange' },
        { id: 'c2', name: 'Bitcoin Wallet' },
      ]);
      prisma.review.findMany.mockResolvedValue([
        { id: 'r1', title: 'Bitcoin Review' },
      ]);
      prisma.user.findMany.mockResolvedValue([]);

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
      prisma.company.findMany.mockResolvedValue([{ id: 'c1' }]);
      prisma.review.findMany.mockResolvedValue([]);
      prisma.user.findMany.mockResolvedValue([]);

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
      prisma.company.findMany.mockResolvedValue([]);

      await service.search('test', 'companies', 10);

      expect(analyticsService.track).not.toHaveBeenCalled();
    });

    it('should not track when analyticsService is absent', async () => {
      const serviceWithoutAnalytics = new SearchService(
        prisma as unknown as PrismaService,
      );
      prisma.company.findMany.mockResolvedValue([]);

      await serviceWithoutAnalytics.search('test', 'companies', 10, mockCtx);

      expect(analyticsService.track).not.toHaveBeenCalled();
    });

    it('should not track for empty query (early return)', async () => {
      await service.search('', 'all', 10, mockCtx);

      expect(analyticsService.track).not.toHaveBeenCalled();
    });
  });
});
