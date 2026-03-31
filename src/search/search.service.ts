import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import type { AnalyticsContext } from '../analytics/analytics-context';
import { RedisService } from '../redis/redis.service';
import { ObservabilityService } from '../observability/observability.service';

const SEARCH_QUERY_MIN_LENGTH = 2;
const SEARCH_QUERY_MAX_LENGTH = 100;
const SEARCH_CACHE_TTL_SEC = 120;

type SearchType = 'all' | 'companies' | 'reviews' | 'users';

type CompanySearchRow = {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  category: string;
};

type ReviewSearchRow = {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  helpfulCount: number;
  downVoteCount: number;
  overallScore: number;
  verified: boolean;
  authorId: string;
  authorUsername: string;
  authorAvatar: string | null;
  companyId: string | null;
  companyName: string | null;
  companySlug: string | null;
};

type UserSearchRow = {
  id: string;
  username: string;
  name: string | null;
  avatar: string | null;
  verified: boolean;
};

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly observability: ObservabilityService,
    @Optional() private readonly analyticsService?: AnalyticsService,
  ) {}

  private normalizeQuery(query: string): string {
    return query.trim().replace(/\s+/g, ' ').slice(0, SEARCH_QUERY_MAX_LENGTH);
  }

  private normalizeType(type: string): SearchType | null {
    if (
      type === 'all' ||
      type === 'companies' ||
      type === 'reviews' ||
      type === 'users'
    ) {
      return type;
    }
    return null;
  }

  private buildCacheKey(query: string, type: SearchType, limit: number): string {
    return `search:v2:${type}:${limit}:${query.toLowerCase()}`;
  }

  private async getCachedResults(query: string, type: SearchType, limit: number) {
    const redis = this.redisService.getClient();
    if (!this.redisService.isReady() || !redis) return null;

    try {
      const cached = await redis.get(this.buildCacheKey(query, type, limit));
      if (!cached) return null;
      this.observability.recordCacheHit('search.public');
      return JSON.parse(cached) as { results: Record<string, unknown> };
    } catch {
      return null;
    }
  }

  private async setCachedResults(
    query: string,
    type: SearchType,
    limit: number,
    payload: { results: Record<string, unknown> },
  ) {
    const redis = this.redisService.getClient();
    if (!this.redisService.isReady() || !redis) return;

    try {
      await redis.set(
        this.buildCacheKey(query, type, limit),
        JSON.stringify(payload),
        'EX',
        SEARCH_CACHE_TTL_SEC,
      );
    } catch {
      // Ignore cache write failures and serve the DB result.
    }
  }

  private searchCompanies(query: string, limit: number) {
    return this.prisma.$queryRaw<CompanySearchRow[]>(Prisma.sql`
      SELECT
        c.id,
        c.name,
        c.slug,
        c.logo,
        c.category::text AS category
      FROM "Company" c
      WHERE
        lower(c.name) LIKE '%' || lower(${query}) || '%'
        OR lower(COALESCE(c.description, '')) LIKE '%' || lower(${query}) || '%'
      ORDER BY
        CASE
          WHEN lower(c.name) = lower(${query}) THEN 3
          WHEN lower(c.name) LIKE lower(${query}) || '%' THEN 2
          WHEN lower(c.name) LIKE '%' || lower(${query}) || '%' THEN 1
          ELSE 0
        END DESC,
        GREATEST(
          similarity(lower(c.name), lower(${query})),
          similarity(lower(COALESCE(c.description, '')), lower(${query}))
        ) DESC,
        c."verified" DESC,
        c."createdAt" DESC
      LIMIT ${limit}
    `);
  }

  private searchReviews(query: string, limit: number) {
    return this.prisma.$queryRaw<ReviewSearchRow[]>(Prisma.sql`
      SELECT
        r.id,
        r.title,
        r.content,
        r."createdAt",
        r."helpfulCount",
        r."downVoteCount",
        r."overallScore",
        r.verified,
        a.id AS "authorId",
        a.username AS "authorUsername",
        a.avatar AS "authorAvatar",
        c.id AS "companyId",
        c.name AS "companyName",
        c.slug AS "companySlug"
      FROM "Review" r
      INNER JOIN "User" a ON a.id = r."authorId"
      LEFT JOIN "Company" c ON c.id = r."companyId"
      WHERE
        r.status = 'APPROVED'
        AND (
          lower(r.title) LIKE '%' || lower(${query}) || '%'
          OR lower(r.content) LIKE '%' || lower(${query}) || '%'
        )
      ORDER BY
        CASE
          WHEN lower(r.title) = lower(${query}) THEN 3
          WHEN lower(r.title) LIKE lower(${query}) || '%' THEN 2
          WHEN lower(r.title) LIKE '%' || lower(${query}) || '%' THEN 1
          ELSE 0
        END DESC,
        GREATEST(
          similarity(lower(r.title), lower(${query})),
          similarity(lower(r.content), lower(${query}))
        ) DESC,
        r."helpfulCount" DESC,
        r."createdAt" DESC
      LIMIT ${limit}
    `);
  }

  private searchUsers(query: string, limit: number) {
    return this.prisma.$queryRaw<UserSearchRow[]>(Prisma.sql`
      SELECT
        u.id,
        u.username,
        u.name,
        u.avatar,
        u.verified
      FROM "User" u
      WHERE
        lower(u.username) LIKE '%' || lower(${query}) || '%'
        OR lower(COALESCE(u.name, '')) LIKE '%' || lower(${query}) || '%'
      ORDER BY
        CASE
          WHEN lower(u.username) = lower(${query}) THEN 3
          WHEN lower(u.username) LIKE lower(${query}) || '%' THEN 2
          WHEN lower(u.username) LIKE '%' || lower(${query}) || '%' THEN 1
          ELSE 0
        END DESC,
        GREATEST(
          similarity(lower(u.username), lower(${query})),
          similarity(lower(COALESCE(u.name, '')), lower(${query}))
        ) DESC,
        u.verified DESC,
        u."createdAt" DESC
      LIMIT ${limit}
    `);
  }

  async search(
    query: string,
    type: string,
    limit: number,
    analyticsCtx?: AnalyticsContext,
    userId?: string,
  ) {
    const normalizedQuery = this.normalizeQuery(query);
    const normalizedType = this.normalizeType(type);

    if (
      !normalizedQuery ||
      normalizedQuery.length < SEARCH_QUERY_MIN_LENGTH ||
      normalizedType === null
    ) {
      return { results: {} };
    }

    const cached = await this.getCachedResults(
      normalizedQuery,
      normalizedType,
      limit,
    );
    if (cached) {
      return cached;
    }
    this.observability.recordCacheMiss('search.public');

    const shouldSearchCompanies =
      normalizedType === 'all' || normalizedType === 'companies';
    const shouldSearchReviews =
      normalizedType === 'all' || normalizedType === 'reviews';
    const shouldSearchUsers =
      normalizedType === 'all' || normalizedType === 'users';

    const [companies, reviews, users] = await Promise.all([
      shouldSearchCompanies
        ? this.searchCompanies(normalizedQuery, limit)
        : Promise.resolve(undefined),
      shouldSearchReviews
        ? this.searchReviews(normalizedQuery, limit).then((rows) =>
            rows.map((row) => ({
              id: row.id,
              title: row.title,
              content: row.content,
              createdAt: row.createdAt,
              helpfulCount: row.helpfulCount,
              downVoteCount: row.downVoteCount,
              overallScore: row.overallScore,
              verified: row.verified,
              author: {
                id: row.authorId,
                username: row.authorUsername,
                avatar: row.authorAvatar,
              },
              company: row.companyId
                ? {
                    id: row.companyId,
                    name: row.companyName,
                    slug: row.companySlug,
                  }
                : null,
            })),
          )
        : Promise.resolve(undefined),
      shouldSearchUsers
        ? this.searchUsers(normalizedQuery, limit)
        : Promise.resolve(undefined),
    ]);

    const results: Record<string, unknown> = {};
    if (companies) results.companies = companies;
    if (reviews) results.reviews = reviews;
    if (users) results.users = users;

    const response = { results };

    await this.setCachedResults(normalizedQuery, normalizedType, limit, response);

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
          properties: {
            query: normalizedQuery,
            type: normalizedType,
            resultCount,
          },
        },
        analyticsCtx.country,
      );
    }

    return response;
  }
}
