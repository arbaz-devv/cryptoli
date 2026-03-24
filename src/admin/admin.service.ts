import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsRollupService } from '../analytics/analytics-rollup.service';
import { ReviewStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';

/**
 * Backend in-memory caches (admin APIs)
 * -------------------------------------
 * All caches are keyed and stored in process memory. No Redis.
 *
 * How it works:
 * - First request (cold): runs the real DB/query, stores result with expiry = now + TTL.
 * - Later request with same key within TTL (warm): returns cached copy immediately.
 * - When writing a new entry we evict any expired keys so the Map doesn't grow forever.
 *
 * TTL is 30 seconds for all. Same request params = same cache key.
 * After 30s the next request is cold again and repopulates the cache.
 */
const REVIEWS_LIST_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const reviewsListCache = new Map<
  string,
  {
    data: {
      reviews: unknown[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    };
    expiry: number;
  }
>();

const STATS_CACHE_TTL_MS = 30 * 1000; // 30 seconds
let statsCache: { data: Record<string, number>; expiry: number } | null = null;

const USERS_LIST_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const usersListCache = new Map<
  string,
  {
    data: {
      users: unknown[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    };
    expiry: number;
  }
>();

const RATINGS_LIST_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const ratingsListCache = new Map<
  string,
  {
    data: {
      ratings: unknown[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    };
    expiry: number;
  }
>();

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(AnalyticsRollupService)
    private readonly rollupService?: AnalyticsRollupService,
  ) {}

  private normalizePagination(page: number, limit: number) {
    const normalizedPage = Math.max(1, page);
    const normalizedLimit = Math.min(100, Math.max(1, limit));
    return { page: normalizedPage, limit: normalizedLimit };
  }

  private buildCreatedAtRange(dateFrom?: string, dateTo?: string) {
    if (!dateFrom && !dateTo) return undefined;

    const range: { gte?: Date; lte?: Date } = {};
    if (dateFrom) range.gte = new Date(dateFrom);
    if (dateTo) {
      const to = new Date(dateTo);
      to.setUTCHours(23, 59, 59, 999);
      range.lte = to;
    }

    return range;
  }

  private startOfToday(): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  async getStats() {
    const now = Date.now();
    if (statsCache && statsCache.expiry > now) return statsCache.data;

    const startOfToday = this.startOfToday();
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      totalUsers,
      activeTodayResult,
      pendingReviews,
      flaggedContent,
      totalReviews,
      productsCount,
      newUsersThisWeek,
      openComplaints,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(DISTINCT "userId") as count FROM "Session" WHERE "createdAt" >= ${startOfToday}
      `.then((rows) => Number(rows[0]?.count ?? 0)),
      this.prisma.review.count({ where: { status: 'PENDING' } }),
      this.prisma.review.count({ where: { status: 'FLAGGED' } }),
      this.prisma.review.count(),
      this.prisma.product.count(),
      this.prisma.user.count({
        where: { createdAt: { gte: oneWeekAgo } },
      }),
      this.prisma.complaint.count({ where: { status: 'OPEN' } }),
    ]);
    const data = {
      totalUsers,
      activeToday: activeTodayResult,
      pendingReviews,
      flaggedContent,
      totalRatings: productsCount,
      newThisWeek: newUsersThisWeek,
      totalReviews,
      openComplaints,
      newFeedbacks: 0,
    };
    statsCache = { data, expiry: now + STATS_CACHE_TTL_MS };
    return data;
  }

  async getUsers(params: {
    page: number;
    limit: number;
    q?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const { page: p, limit: l } = this.normalizePagination(
      params.page,
      params.limit,
    );
    const cacheKey = JSON.stringify({
      page: p,
      limit: l,
      q: params.q ?? null,
      dateFrom: params.dateFrom ?? null,
      dateTo: params.dateTo ?? null,
    });
    const now = Date.now();
    const hit = usersListCache.get(cacheKey);
    if (hit && hit.expiry > now) {
      return {
        users: [...hit.data.users],
        pagination: { ...hit.data.pagination },
      };
    }

    const where: {
      createdAt?: { gte?: Date; lte?: Date };
      OR?: Array<{
        email?: { contains: string; mode: 'insensitive' };
        name?: { contains: string; mode: 'insensitive' };
        username?: { contains: string; mode: 'insensitive' };
      }>;
    } = {};
    const createdAtRange = this.buildCreatedAtRange(
      params.dateFrom,
      params.dateTo,
    );
    if (createdAtRange) where.createdAt = createdAtRange;
    if (params.q?.trim()) {
      const q = params.q.trim();
      where.OR = [
        { email: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
      ];
    }
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: (p - 1) * l,
        take: l,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          username: true,
          name: true,
          avatar: true,
          role: true,
          createdAt: true,
          _count: { select: { reviews: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    const list = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name ?? u.username,
      username: u.username,
      role: u.role.toLowerCase(),
      status: 'active' as const,
      joinedAt: u.createdAt.toISOString().slice(0, 10),
      reviewCount: u._count.reviews,
      lastActive: '-',
    }));
    const result = {
      users: list,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
      },
    };
    usersListCache.set(cacheKey, {
      data: result,
      expiry: now + USERS_LIST_CACHE_TTL_MS,
    });
    for (const key of usersListCache.keys()) {
      const e = usersListCache.get(key);
      if (e && e.expiry <= Date.now()) usersListCache.delete(key);
    }
    return result;
  }

  async getUserDetail(id: string, lazy = false) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatar: true,
        role: true,
        verified: true,
        reputation: true,
        registrationIp: true,
        registrationCountry: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { reviews: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    if (lazy) {
      return {
        lazy: true,
        deferred: [
          'metrics',
          'activitySeries',
          'reviews',
          'complaints',
          'discussions',
        ],
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name ?? user.username,
          role: user.role.toLowerCase(),
          status: 'active',
          joinedAt: user.createdAt.toISOString().slice(0, 10),
          reviewCount: user._count.reviews,
          lastActive: user.updatedAt.toISOString().slice(0, 10),
          lastLoginAt: undefined,
        },
        metrics: null,
        activitySeries: [],
        reviews: [],
        complaints: [],
        discussions: [],
        feedbacks: [],
      };
    }

    const [
      commentsCount,
      helpfulVotesCount,
      complaintVotesCount,
      commentVotesCount,
      reviews,
      complaints,
      posts,
      sessions,
      comments,
      helpfulVotes,
    ] = await Promise.all([
      this.prisma.comment.count({ where: { authorId: id } }),
      this.prisma.helpfulVote.count({ where: { userId: id } }),
      this.prisma.complaintVote.count({ where: { userId: id } }),
      this.prisma.commentVote.count({ where: { userId: id } }),
      this.prisma.review.findMany({
        where: { authorId: id },
        take: 8,
        orderBy: { createdAt: 'desc' },
        include: {
          product: { select: { name: true } },
          company: { select: { name: true } },
        },
      }),
      this.prisma.complaint.findMany({
        where: { authorId: id },
        take: 8,
        orderBy: { createdAt: 'desc' },
        include: {
          product: { select: { name: true } },
          company: { select: { name: true } },
        },
      }),
      this.prisma.post.findMany({
        where: { authorId: id },
        take: 8,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { comments: true } } },
      }),
      this.prisma.session.findMany({
        where: { userId: id },
        select: {
          createdAt: true,
          ip: true,
          ipHash: true,
          device: true,
          browser: true,
          os: true,
          country: true,
          timezone: true,
          trigger: true,
        },
      }),
      this.prisma.comment.findMany({
        where: { authorId: id },
        select: { createdAt: true },
      }),
      this.prisma.helpfulVote.findMany({
        where: { userId: id },
        select: { createdAt: true },
      }),
    ]);

    const dayKeys = Array.from({ length: 30 }, (_, idx) => {
      const d = new Date();
      d.setDate(d.getDate() - (29 - idx));
      return d.toISOString().slice(0, 10);
    });
    const seriesMap: Record<
      string,
      {
        logins: number;
        comments: number;
        votes: number;
        devices: Record<string, number>;
        countries: Record<string, number>;
      }
    > = {};
    dayKeys.forEach((key) => {
      seriesMap[key] = {
        logins: 0,
        comments: 0,
        votes: 0,
        devices: {},
        countries: {},
      };
    });
    sessions.forEach((s) => {
      const key = s.createdAt.toISOString().slice(0, 10);
      if (seriesMap[key]) {
        seriesMap[key].logins += 1;
        if (s.device) {
          seriesMap[key].devices[s.device] =
            (seriesMap[key].devices[s.device] || 0) + 1;
        }
        if (s.country) {
          seriesMap[key].countries[s.country] =
            (seriesMap[key].countries[s.country] || 0) + 1;
        }
      }
    });
    comments.forEach((c) => {
      const key = c.createdAt.toISOString().slice(0, 10);
      if (seriesMap[key]) seriesMap[key].comments += 1;
    });
    helpfulVotes.forEach((v) => {
      const key = v.createdAt.toISOString().slice(0, 10);
      if (seriesMap[key]) seriesMap[key].votes += 1;
    });

    // Derive most-frequent value from a Record<string, number>
    const topEntry = (map: Record<string, number>): string | undefined => {
      let best: string | undefined;
      let max = 0;
      for (const [k, v] of Object.entries(map)) {
        if (v > max) {
          max = v;
          best = k;
        }
      }
      return best;
    };

    const sortedSessions = [...sessions].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const latestSession = sortedSessions[0] ?? null;
    const earliestSession = sortedSessions[sortedSessions.length - 1] ?? null;

    const lastActivityDate = [
      user.updatedAt,
      ...reviews.map((r) => r.createdAt),
      ...complaints.map((c) => c.createdAt),
      ...posts.map((p) => p.createdAt),
    ].reduce((max, current) => (current > max ? current : max), user.createdAt);

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name ?? user.username,
        role: user.role.toLowerCase(),
        status: 'active',
        joinedAt: user.createdAt.toISOString().slice(0, 10),
        reviewCount: user._count.reviews,
        lastActive: lastActivityDate.toISOString().slice(0, 10),
        lastLoginAt: latestSession
          ? latestSession.createdAt.toISOString()
          : undefined,
        lastLoginIp: latestSession?.ip ?? undefined,
        registrationIp: user.registrationIp ?? earliestSession?.ip ?? undefined,
        registrationCountry:
          user.registrationCountry ?? earliestSession?.country ?? undefined,
        device: latestSession?.device ?? undefined,
        browser: latestSession?.browser ?? undefined,
        os: latestSession?.os ?? undefined,
        country: latestSession?.country ?? undefined,
        timezone: latestSession?.timezone ?? undefined,
        loginCount: sessions.length,
      },
      metrics: {
        commentsCount,
        votesCount: helpfulVotesCount + complaintVotesCount + commentVotesCount,
      },
      activitySeries: dayKeys.map((date) => ({
        date,
        device: topEntry(seriesMap[date].devices) ?? 'Unknown',
        country: topEntry(seriesMap[date].countries) ?? 'Unknown',
        logins: seriesMap[date].logins,
        comments: seriesMap[date].comments,
        votes: seriesMap[date].votes,
      })),
      reviews: reviews.map((r) => ({
        id: r.id,
        title: r.title,
        productName: r.product?.name ?? r.company?.name ?? '-',
        score: r.overallScore,
        status: r.status.toLowerCase(),
        createdAt: r.createdAt.toISOString(),
      })),
      complaints: complaints.map((c) => ({
        id: c.id,
        subject: c.title,
        relatedTo: c.product ? 'product' : c.company ? 'company' : 'general',
        priority:
          c.reportCount >= 10 ? 'high' : c.reportCount >= 3 ? 'medium' : 'low',
        status:
          c.status.toLowerCase() === 'closed'
            ? 'dismissed'
            : c.status.toLowerCase(),
        createdAt: c.createdAt.toISOString(),
      })),
      discussions: posts.map((p) => ({
        id: p.id,
        title: p.content.slice(0, 72) + (p.content.length > 72 ? '...' : ''),
        category: 'Post',
        commentCount: p._count.comments,
        status: 'open',
        createdAt: p.createdAt.toISOString(),
      })),
      feedbacks: [],
    };
  }

  async getReviews(params: {
    page: number;
    limit: number;
    includeTotal?: boolean;
    status?: ReviewStatus;
    q?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const { page: p, limit: l } = this.normalizePagination(
      params.page,
      params.limit,
    );
    const includeTotal = params.includeTotal ?? true;
    const cacheKey = JSON.stringify({
      page: p,
      limit: l,
      includeTotal,
      status: params.status ?? null,
      q: params.q ?? null,
      dateFrom: params.dateFrom ?? null,
      dateTo: params.dateTo ?? null,
    });
    const now = Date.now();
    const hit = reviewsListCache.get(cacheKey);
    if (hit && hit.expiry > now) {
      return { ...hit.data, reviews: [...hit.data.reviews] };
    }

    const where: Prisma.ReviewWhereInput = {};
    if (params.status) where.status = params.status;
    const createdAtRange = this.buildCreatedAtRange(
      params.dateFrom,
      params.dateTo,
    );
    if (createdAtRange) where.createdAt = createdAtRange;
    if (params.q?.trim()) {
      const q = params.q.trim();
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { content: { contains: q, mode: 'insensitive' } },
        { author: { name: { contains: q, mode: 'insensitive' } } },
        { author: { username: { contains: q, mode: 'insensitive' } } },
        { product: { name: { contains: q, mode: 'insensitive' } } },
        { company: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }
    const reviewsPromise = this.prisma.review.findMany({
      where,
      skip: (p - 1) * l,
      take: l,
      orderBy: { createdAt: 'desc' },
      include: {
        author: { select: { id: true, username: true, name: true } },
        product: { select: { id: true, name: true, slug: true } },
        company: { select: { id: true, name: true, slug: true } },
        _count: { select: { comments: true } },
      },
    });
    const [reviews, total] = includeTotal
      ? await Promise.all([reviewsPromise, this.prisma.review.count({ where })])
      : await Promise.all([reviewsPromise, Promise.resolve(0)]);
    const list = reviews.map((r) => ({
      id: r.id,
      title: r.title,
      excerpt: r.content.slice(0, 120) + (r.content.length > 120 ? '...' : ''),
      author: r.author?.name ?? r.author?.username ?? 'Unknown',
      authorId: r.authorId,
      productName: r.product?.name ?? r.company?.name ?? '-',
      productId: r.productId,
      companyId: r.companyId,
      score: r.overallScore,
      helpfulCount: r.helpfulCount,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      commentCount: r._count.comments,
    }));
    const result = {
      reviews: list,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: includeTotal ? Math.ceil(total / l) : 0,
      },
    };
    reviewsListCache.set(cacheKey, {
      data: result,
      expiry: now + REVIEWS_LIST_CACHE_TTL_MS,
    });
    for (const key of reviewsListCache.keys()) {
      const e = reviewsListCache.get(key);
      if (e && e.expiry <= Date.now()) reviewsListCache.delete(key);
    }
    return result;
  }

  async getReview(id: string, lazy = false) {
    if (lazy) {
      const review = await this.prisma.review.findUnique({
        where: { id },
        include: {
          author: { select: { id: true, username: true, name: true } },
          product: { select: { id: true, name: true, slug: true } },
          company: { select: { id: true, name: true, slug: true } },
          _count: { select: { comments: true } },
        },
      });
      if (!review) throw new NotFoundException('Review not found');

      return {
        lazy: true,
        deferred: ['comments', 'helpfulVotes', 'reactions'],
        id: review.id,
        title: review.title,
        excerpt:
          review.content.slice(0, 120) +
          (review.content.length > 120 ? '...' : ''),
        body: review.content,
        author: review.author?.name ?? review.author?.username ?? 'Unknown',
        authorId: review.authorId,
        productName: review.product?.name ?? review.company?.name ?? '-',
        productId: review.productId,
        companyId: review.companyId,
        score: review.overallScore,
        helpfulCount: review.helpfulCount,
        downVoteCount: review.downVoteCount,
        reportCount: review.reportCount,
        status: review.status,
        createdAt: review.createdAt.toISOString(),
        updatedAt: review.updatedAt.toISOString(),
        commentCount: review._count.comments,
        reactions: {},
        helpfulVotes: [],
        comments: [],
      };
    }

    const review = await this.prisma.review.findUnique({
      where: { id },
      include: {
        author: { select: { id: true, username: true, name: true } },
        product: { select: { id: true, name: true, slug: true } },
        company: { select: { id: true, name: true, slug: true } },
        _count: { select: { comments: true } },
        reactions: { select: { type: true } },
        helpfulVotes: {
          select: { userId: true, voteType: true, createdAt: true },
        },
        comments: {
          where: { parentId: null },
          orderBy: { createdAt: 'asc' },
          include: {
            author: { select: { id: true, username: true, name: true } },
            replies: {
              orderBy: { createdAt: 'asc' },
              include: {
                author: { select: { id: true, username: true, name: true } },
              },
            },
          },
        },
      },
    });
    if (!review) throw new NotFoundException('Review not found');

    const reactionCounts = (review.reactions as { type: string }[]).reduce(
      (acc, r) => {
        acc[r.type] = (acc[r.type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const mapComment = (c: {
      id: string;
      content: string;
      authorId: string;
      author: { id: string; name: string | null; username: string | null };
      helpfulCount: number;
      downVoteCount: number;
      createdAt: Date;
      replies?: Array<{
        id: string;
        content: string;
        authorId: string;
        author: { id: string; name: string | null; username: string | null };
        helpfulCount: number;
        downVoteCount: number;
        createdAt: Date;
      }>;
    }) => ({
      id: c.id,
      content: c.content,
      authorId: c.authorId,
      author: c.author?.name ?? c.author?.username ?? 'Unknown',
      helpfulCount: c.helpfulCount,
      downVoteCount: c.downVoteCount,
      createdAt: c.createdAt.toISOString(),
      replyCount: c.replies?.length ?? 0,
      replies: (c.replies ?? []).map((r) => ({
        id: r.id,
        content: r.content,
        authorId: r.authorId,
        author: r.author?.name ?? r.author?.username ?? 'Unknown',
        helpfulCount: r.helpfulCount,
        downVoteCount: r.downVoteCount,
        createdAt: r.createdAt.toISOString(),
      })),
    });

    return {
      id: review.id,
      title: review.title,
      excerpt:
        review.content.slice(0, 120) +
        (review.content.length > 120 ? '...' : ''),
      body: review.content,
      author: review.author?.name ?? review.author?.username ?? 'Unknown',
      authorId: review.authorId,
      productName: review.product?.name ?? review.company?.name ?? '-',
      productId: review.productId,
      companyId: review.companyId,
      score: review.overallScore,
      helpfulCount: review.helpfulCount,
      downVoteCount: review.downVoteCount,
      reportCount: review.reportCount,
      status: review.status,
      createdAt: review.createdAt.toISOString(),
      updatedAt: review.updatedAt.toISOString(),
      commentCount: review._count.comments,
      reactions: reactionCounts,
      helpfulVotes: review.helpfulVotes.map((v) => ({
        userId: v.userId,
        voteType: v.voteType,
        createdAt: v.createdAt.toISOString(),
      })),
      comments: review.comments.map(mapComment),
    };
  }

  async updateReviewStatus(id: string, status: ReviewStatus) {
    const existing = await this.prisma.review.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Review not found');
    const review = await this.prisma.review.update({
      where: { id },
      data: { status },
    });
    return { ok: true, review: { id: review.id, status: review.status } };
  }

  async getRatings(params: { page: number; limit: number }) {
    const { page: p, limit: l } = this.normalizePagination(
      params.page,
      params.limit,
    );
    const cacheKey = `${p}:${l}`;
    const now = Date.now();
    const hit = ratingsListCache.get(cacheKey);
    if (hit && hit.expiry > now) {
      return {
        ratings: [...hit.data.ratings],
        pagination: { ...hit.data.pagination },
      };
    }

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        skip: (p - 1) * l,
        take: l,
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          slug: true,
          category: true,
          company: { select: { name: true } },
          _count: { select: { reviews: true } },
        },
      }),
      this.prisma.product.count(),
    ]);

    const productIds = products.map((prod) => prod.id);
    if (productIds.length === 0) {
      const result = {
        ratings: [],
        pagination: {
          page: p,
          limit: l,
          total,
          totalPages: Math.ceil(total / l),
        },
      };
      ratingsListCache.set(cacheKey, {
        data: result,
        expiry: now + RATINGS_LIST_CACHE_TTL_MS,
      });
      return result;
    }

    const [approvedAgg, newWeekAgg] = await Promise.all([
      this.prisma.review.groupBy({
        by: ['productId'],
        where: { productId: { in: productIds }, status: 'APPROVED' },
        _avg: { overallScore: true },
        _count: true,
        _max: { createdAt: true },
      }),
      this.prisma.review.groupBy({
        by: ['productId'],
        where: {
          productId: { in: productIds },
          status: 'APPROVED',
          createdAt: { gte: oneWeekAgo },
        },
        _count: true,
      }),
    ]);

    const productIdSet = new Set(productIds);
    const approvedByProduct = new Map(
      approvedAgg
        .filter((r) => r.productId != null && productIdSet.has(r.productId))
        .map((r) => [r.productId!, r] as const),
    );
    const newWeekByProduct = new Map(
      newWeekAgg
        .filter((r) => r.productId != null && productIdSet.has(r.productId))
        .map((r) => [r.productId!, r._count] as const),
    );

    const list = products.map((prod) => {
      const agg = approvedByProduct.get(prod.id);
      const approvedCount = agg?._count ?? 0;
      const avgScore = agg?._avg?.overallScore ?? 0;
      const lastAt = agg?._max?.createdAt;
      const newThisWeek = newWeekByProduct.get(prod.id) ?? 0;
      return {
        id: prod.id,
        productName: prod.name,
        slug: prod.slug,
        category: prod.category,
        score: Math.round(avgScore * 10) / 10,
        reviewCount: prod._count.reviews,
        submittedBy: prod.company?.name ?? '-',
        updatedAt: lastAt ? lastAt.toISOString().slice(0, 10) : '-',
        status: approvedCount > 0 ? 'published' : 'pending',
        trend: newThisWeek > 0 ? 'up' : 'stable',
      };
    });
    const result = {
      ratings: list,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
      },
    };
    ratingsListCache.set(cacheKey, {
      data: result,
      expiry: now + RATINGS_LIST_CACHE_TTL_MS,
    });
    for (const key of ratingsListCache.keys()) {
      const e = ratingsListCache.get(key);
      if (e && e.expiry <= Date.now()) ratingsListCache.delete(key);
    }
    return result;
  }

  async getUserSessions(userId: string, page: number, limit: number) {
    const { page: p, limit: l } = this.normalizePagination(page, limit);
    const where = { userId };

    const [sessions, total] = await Promise.all([
      this.prisma.session.findMany({
        where,
        skip: (p - 1) * l,
        take: l,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
          ip: true,
          ipHash: true,
          userAgent: true,
          device: true,
          browser: true,
          os: true,
          country: true,
          timezone: true,
          trigger: true,
        },
      }),
      this.prisma.session.count({ where }),
    ]);

    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        ipHash: s.ipHash ?? undefined,
        userAgent: s.userAgent ?? undefined,
        device: s.device ?? undefined,
        browser: s.browser ?? undefined,
        os: s.os ?? undefined,
        country: s.country ?? undefined,
        timezone: s.timezone ?? undefined,
        trigger: s.trigger ?? undefined,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
      })),
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
      },
    };
  }

  async getUserSessionsExport(userId: string, format: 'csv' | 'json') {
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        ipHash: true,
        userAgent: true,
        device: true,
        browser: true,
        os: true,
        country: true,
        timezone: true,
        trigger: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    if (format === 'csv') {
      return this.sessionsToCSV(sessions);
    }

    return sessions.map((s) => ({
      ipHash: s.ipHash ?? '',
      userAgent: s.userAgent ?? '',
      device: s.device ?? '',
      browser: s.browser ?? '',
      os: s.os ?? '',
      country: s.country ?? '',
      timezone: s.timezone ?? '',
      trigger: s.trigger ?? '',
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    }));
  }

  private sessionsToCSV(
    sessions: Array<{
      ipHash: string | null;
      userAgent: string | null;
      device: string | null;
      browser: string | null;
      os: string | null;
      country: string | null;
      timezone: string | null;
      trigger: string | null;
      createdAt: Date;
      expiresAt: Date;
    }>,
  ): string {
    const BOM = '\uFEFF';
    const headers = [
      'IP Hash',
      'User Agent',
      'Device',
      'Browser',
      'OS',
      'Country',
      'Timezone',
      'Trigger',
      'Created At',
      'Expires At',
    ];

    const escapeCSV = (val: string): string => {
      if (val.includes('"') || val.includes(',') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    const rows = sessions.map((s) =>
      [
        s.ipHash ?? '',
        s.userAgent ?? '',
        s.device ?? '',
        s.browser ?? '',
        s.os ?? '',
        s.country ?? '',
        s.timezone ?? '',
        s.trigger ?? '',
        s.createdAt.toISOString(),
        s.expiresAt.toISOString(),
      ]
        .map(escapeCSV)
        .join(','),
    );

    return BOM + headers.join(',') + '\n' + rows.join('\n');
  }

  async getUserActivity(userId: string, page: number, limit: number) {
    const { page: p, limit: l } = this.normalizePagination(page, limit);
    const cap = p * l;

    const [reviews, comments, complaints, helpfulVotes, follows] =
      await Promise.all([
        this.prisma.review.findMany({
          where: { authorId: userId },
          take: cap,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            createdAt: true,
            product: { select: { name: true } },
            company: { select: { name: true } },
          },
        }),
        this.prisma.comment.findMany({
          where: { authorId: userId },
          take: cap,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            content: true,
            createdAt: true,
          },
        }),
        this.prisma.complaint.findMany({
          where: { authorId: userId },
          take: cap,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            createdAt: true,
            product: { select: { name: true } },
            company: { select: { name: true } },
          },
        }),
        this.prisma.helpfulVote.findMany({
          where: { userId },
          take: cap,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            reviewId: true,
            createdAt: true,
          },
        }),
        this.prisma.follow.findMany({
          where: { followerId: userId },
          take: cap,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            createdAt: true,
            following: { select: { username: true, name: true } },
          },
        }),
      ]);

    const unified: Array<{
      type: string;
      id: string;
      summary: string;
      createdAt: string;
    }> = [];

    for (const r of reviews) {
      unified.push({
        type: 'review',
        id: r.id,
        summary: `Reviewed: ${r.title} (${r.product?.name ?? r.company?.name ?? '-'})`,
        createdAt: r.createdAt.toISOString(),
      });
    }
    for (const c of comments) {
      unified.push({
        type: 'comment',
        id: c.id,
        summary: `Commented: ${c.content.slice(0, 80)}${c.content.length > 80 ? '...' : ''}`,
        createdAt: c.createdAt.toISOString(),
      });
    }
    for (const c of complaints) {
      unified.push({
        type: 'complaint',
        id: c.id,
        summary: `Complaint: ${c.title} (${c.product?.name ?? c.company?.name ?? '-'})`,
        createdAt: c.createdAt.toISOString(),
      });
    }
    for (const v of helpfulVotes) {
      unified.push({
        type: 'helpful_vote',
        id: v.id,
        summary: `Voted helpful on review ${v.reviewId}`,
        createdAt: v.createdAt.toISOString(),
      });
    }
    for (const f of follows) {
      unified.push({
        type: 'follow',
        id: f.id,
        summary: `Followed ${f.following?.name ?? f.following?.username ?? 'user'}`,
        createdAt: f.createdAt.toISOString(),
      });
    }

    unified.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const start = (p - 1) * l;
    const paged = unified.slice(start, start + l);
    const total = unified.length;

    return {
      activities: paged,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
      },
    };
  }

  async rollupAnalytics(body: { date?: string; from?: string; to?: string }) {
    if (!this.rollupService) {
      return { ok: false, error: 'Rollup service not available' };
    }

    const start = Date.now();

    if (body.date) {
      const result = await this.rollupService.rollupDay(body.date);
      return {
        ok: true,
        rolledUp: result ? 1 : 0,
        skipped: result ? 0 : 1,
        errors: 0,
        durationMs: Date.now() - start,
      };
    }

    if (body.from && body.to) {
      const days: string[] = [];
      const fromDate = new Date(body.from);
      const toDate = new Date(body.to);

      // Cap at 365 days
      const maxDate = new Date(fromDate);
      maxDate.setDate(maxDate.getDate() + 365);
      const effectiveTo = toDate > maxDate ? maxDate : toDate;

      const current = new Date(fromDate);
      while (current <= effectiveTo) {
        days.push(current.toISOString().slice(0, 10));
        current.setDate(current.getDate() + 1);
      }

      let rolledUp = 0;
      let skipped = 0;
      let errors = 0;

      // Process in chunks of 10 concurrent
      for (let i = 0; i < days.length; i += 10) {
        const chunk = days.slice(i, i + 10);
        const results = await Promise.allSettled(
          chunk.map((day) => this.rollupService!.rollupDay(day)),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value) rolledUp++;
            else skipped++;
          } else {
            errors++;
          }
        }
      }

      return {
        ok: true,
        rolledUp,
        skipped,
        errors,
        durationMs: Date.now() - start,
      };
    }

    // Default: yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const day = yesterday.toISOString().slice(0, 10);
    const result = await this.rollupService.rollupDay(day);
    return {
      ok: true,
      rolledUp: result ? 1 : 0,
      skipped: result ? 0 : 1,
      errors: 0,
      durationMs: Date.now() - start,
    };
  }
}
