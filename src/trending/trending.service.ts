import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ObservabilityService } from '../observability/observability.service';

const TRENDING_CACHE_PREFIX = 'trending:v1:';
const TRENDING_CACHE_TTL_SEC = 120;

@Injectable()
export class TrendingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly observability: ObservabilityService,
  ) {}

  async getTrending(period: string, limit: number) {
    const redis = this.redisService.getClient();
    const cacheEnabled = this.redisService.isReady() && redis !== null;
    const cacheKey = `${TRENDING_CACHE_PREFIX}${period}:${limit}`;

    if (cacheEnabled) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          this.observability.recordCacheHit('trending.public');
          return JSON.parse(cached) as {
            trendingNow: Array<{
              id: string;
              name: string;
              description: string;
              likes: number;
              averageScore: number;
              reviewCount: number;
            }>;
            topRatedThisWeek: Array<{
              id: string;
              name: string;
              description: string;
              likes: number;
              averageScore: number;
              reviewCount: number;
            }>;
          };
        }
        this.observability.recordCacheMiss('trending.public');
      } catch {
        // ignore cache read errors
      }
    }

    const daysAgo = period === 'month' ? 30 : 7;
    const weekThreshold = new Date();
    weekThreshold.setDate(weekThreshold.getDate() - daysAgo);

    const [trendingReviews, topRatedReviews] = await Promise.all([
      this.prisma.review.findMany({
        where: {
          status: 'APPROVED',
        },
        select: {
          id: true,
          title: true,
          content: true,
          overallScore: true,
          helpfulCount: true,
          createdAt: true,
        },
        orderBy: [{ helpfulCount: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      }),
      this.prisma.review.findMany({
        where: {
          status: 'APPROVED',
          createdAt: { gte: weekThreshold },
        },
        select: {
          id: true,
          title: true,
          content: true,
          overallScore: true,
          helpfulCount: true,
          createdAt: true,
        },
        orderBy: [
          { overallScore: 'desc' },
          { helpfulCount: 'desc' },
          { createdAt: 'desc' },
        ],
        take: limit,
      }),
    ]);

    const mapReviewCard = (review: {
      id: string;
      title: string;
      content: string;
      overallScore: number;
      helpfulCount: number;
    }) => ({
      id: review.id,
      name: review.title,
      description: review.content,
      likes: review.helpfulCount ?? 0,
      averageScore: review.overallScore ?? 0,
      reviewCount: 1,
    });

    const result = {
      trendingNow: trendingReviews.map(mapReviewCard),
      topRatedThisWeek: topRatedReviews.map(mapReviewCard),
    };

    if (cacheEnabled) {
      try {
        await redis.setex(
          cacheKey,
          TRENDING_CACHE_TTL_SEC,
          JSON.stringify(result),
        );
      } catch {
        // ignore cache write errors
      }
    }

    return result;
  }
}
