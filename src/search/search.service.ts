import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import type { AnalyticsContext } from '../analytics/analytics-context';

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly analyticsService?: AnalyticsService,
  ) {}

  async search(
    query: string,
    type: string,
    limit: number,
    analyticsCtx?: AnalyticsContext,
    userId?: string,
  ) {
    if (!query) {
      return { results: {} };
    }

    const shouldSearchCompanies = type === 'all' || type === 'companies';
    const shouldSearchReviews = type === 'all' || type === 'reviews';
    const shouldSearchUsers = type === 'all' || type === 'users';

    const [companies, reviews, users] = await Promise.all([
      shouldSearchCompanies
        ? this.prisma.company.findMany({
            where: {
              OR: [
                { name: { contains: query, mode: 'insensitive' } },
                { description: { contains: query, mode: 'insensitive' } },
              ],
            },
            take: limit,
            select: {
              id: true,
              name: true,
              slug: true,
              logo: true,
              category: true,
            },
          })
        : Promise.resolve(undefined),
      shouldSearchReviews
        ? this.prisma.review.findMany({
            where: {
              status: 'APPROVED',
              OR: [
                { title: { contains: query, mode: 'insensitive' } },
                { content: { contains: query, mode: 'insensitive' } },
              ],
            },
            take: limit,
            include: {
              author: {
                select: {
                  id: true,
                  username: true,
                  avatar: true,
                },
              },
              company: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                },
              },
            },
          })
        : Promise.resolve(undefined),
      shouldSearchUsers
        ? this.prisma.user.findMany({
            where: {
              OR: [
                { username: { contains: query, mode: 'insensitive' } },
                { name: { contains: query, mode: 'insensitive' } },
              ],
            },
            take: limit,
            select: {
              id: true,
              username: true,
              name: true,
              avatar: true,
              verified: true,
            },
          })
        : Promise.resolve(undefined),
    ]);

    const results: Record<string, unknown> = {};
    if (companies) results.companies = companies;
    if (reviews) results.reviews = reviews;
    if (users) results.users = users;

    if (analyticsCtx && this.analyticsService) {
      const resultCount = Object.values(results).reduce<number>(
        (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0,
      );
      void this.analyticsService.track(
        analyticsCtx.ip,
        analyticsCtx.userAgent,
        {
          event: 'search_performed',
          consent: true,
          userId,
          properties: { query, type, resultCount },
        },
        analyticsCtx.country,
      );
    }

    return { results };
  }
}
