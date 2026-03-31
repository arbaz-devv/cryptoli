import { TrendingService } from './trending.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import { createRedisMock } from '../../test/helpers/redis.mock';
import { ObservabilityService } from '../observability/observability.service';

describe('TrendingService', () => {
  let service: TrendingService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let redisService: ReturnType<typeof createRedisMock>;
  let observability: { recordCacheHit: jest.Mock; recordCacheMiss: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaMock();
    redisService = createRedisMock(false);
    observability = {
      recordCacheHit: jest.fn(),
      recordCacheMiss: jest.fn(),
    };
    service = new TrendingService(
      prisma as unknown as PrismaService,
      redisService as unknown as RedisService,
      observability as unknown as ObservabilityService,
    );
  });

  it('should return trendingNow and topRatedThisWeek', async () => {
    prisma.review.findMany
      .mockResolvedValueOnce([
        {
          id: 'r1',
          title: 'Trending',
          content: 'x',
          overallScore: 8,
          helpfulCount: 50,
          createdAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'r2',
          title: 'Top Rated',
          content: 'y',
          overallScore: 9.5,
          helpfulCount: 10,
          createdAt: new Date(),
        },
      ]);

    const result = await service.getTrending('week', 10);

    expect(result.trendingNow).toHaveLength(1);
    expect(result.topRatedThisWeek).toHaveLength(1);
    expect(result.trendingNow[0].name).toBe('Trending');
    expect(result.trendingNow[0].likes).toBe(50);
    expect(result.topRatedThisWeek[0].averageScore).toBe(9.5);
  });

  it('should use 30-day window for month period', async () => {
    prisma.review.findMany.mockResolvedValue([]);

    await service.getTrending('month', 5);

    // Second call (topRated) should have a date filter
    const topRatedCall = prisma.review.findMany.mock.calls[1][0];
    expect(topRatedCall.where.createdAt.gte).toBeDefined();
    const daysAgo =
      (Date.now() - topRatedCall.where.createdAt.gte.getTime()) /
      (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeCloseTo(30, 0);
  });

  it('should use 7-day window for week period', async () => {
    prisma.review.findMany.mockResolvedValue([]);

    await service.getTrending('week', 5);

    const topRatedCall = prisma.review.findMany.mock.calls[1][0];
    const daysAgo =
      (Date.now() - topRatedCall.where.createdAt.gte.getTime()) /
      (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeCloseTo(7, 0);
  });

  it('should map review fields correctly', async () => {
    prisma.review.findMany.mockResolvedValue([
      {
        id: 'r1',
        title: 'Test',
        content: 'Content',
        overallScore: 7,
        helpfulCount: 3,
      },
    ]);

    const result = await service.getTrending('week', 10);

    const item = result.trendingNow[0];
    expect(item.id).toBe('r1');
    expect(item.name).toBe('Test');
    expect(item.description).toBe('Content');
    expect(item.likes).toBe(3);
    expect(item.averageScore).toBe(7);
    expect(item.reviewCount).toBe(1);
  });
});
