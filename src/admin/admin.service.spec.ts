import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import { ObservabilityService } from '../observability/observability.service';
import { createRedisMock } from '../../test/helpers/redis.mock';
import { RedisService } from '../redis/redis.service';

describe('AdminService', () => {
  let service: AdminService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let redisService: ReturnType<typeof createRedisMock>;
  let observability: {
    recordCacheHit: jest.Mock;
    recordCacheMiss: jest.Mock;
    getSnapshot: jest.Mock;
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    redisService = createRedisMock(false);
    observability = {
      recordCacheHit: jest.fn(),
      recordCacheMiss: jest.fn(),
      getSnapshot: jest.fn().mockReturnValue({ generatedAt: 'now' }),
    };
    service = new AdminService(
      prisma as unknown as PrismaService,
      redisService as unknown as RedisService,
      observability as unknown as ObservabilityService,
    );
  });

  describe('getStats()', () => {
    it('should return platform stats', async () => {
      prisma.user.count.mockResolvedValueOnce(100).mockResolvedValueOnce(5);
      prisma.$queryRaw.mockResolvedValue([{ count: BigInt(42) }]);
      prisma.review.count
        .mockResolvedValueOnce(3) // pending
        .mockResolvedValueOnce(1) // flagged
        .mockResolvedValueOnce(50); // total
      prisma.product.count.mockResolvedValue(10);
      prisma.complaint.count.mockResolvedValue(7);

      const stats = await service.getStats();

      expect(stats.totalUsers).toBe(100);
      expect(stats.activeToday).toBe(42);
      expect(stats.pendingReviews).toBe(3);
      expect(stats.flaggedContent).toBe(1);
      expect(stats.totalReviews).toBe(50);
      expect(stats.totalRatings).toBe(10);
      expect(stats.openComplaints).toBe(7);
      expect(stats.newThisWeek).toBe(5);
      expect(observability.recordCacheMiss).toHaveBeenCalledWith('admin.stats');
    });
  });

  describe('getObservabilitySnapshot()', () => {
    it('should delegate to observability service with all scope', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ ok: 1 }])
        .mockResolvedValueOnce([{ size_bytes: BigInt(1024) }])
        .mockResolvedValueOnce([{ count: BigInt(3) }]);
      const snapshot = await service.getObservabilitySnapshot();
      expect(snapshot.generatedAt).toEqual('now');
      expect(observability.getSnapshot).toHaveBeenCalledWith({ scope: 'all' });
      expect(snapshot.dependencies.database.ready).toBe(true);
      expect(snapshot.cache.adminMemoryStores.stores).toBeDefined();
    });
  });

  describe('getUsers()', () => {
    it('should return paginated users', async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          email: 'a@b.com',
          username: 'alice',
          name: 'Alice',
          avatar: null,
          role: 'USER',
          createdAt: new Date('2026-01-15'),
          moderation: null,
          _count: { reviews: 3 },
        },
      ]);
      prisma.user.count.mockResolvedValue(1);

      const result = await service.getUsers({ page: 1, limit: 10 });

      expect(result.users).toHaveLength(1);
      expect((result.users[0] as any).name).toBe('Alice');
      expect((result.users[0] as any).role).toBe('user');
      expect((result.users[0] as any).reviewCount).toBe(3);
      expect(result.pagination.total).toBe(1);
    });

    it('should apply search filter', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.getUsers({ page: 1, limit: 10, q: 'alice' });

      const findCall = prisma.user.findMany.mock.calls[0][0];
      expect(findCall.where.OR).toBeDefined();
      expect(findCall.where.OR).toHaveLength(3);
    });

    it('should apply date range filter', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.getUsers({
        page: 1,
        limit: 10,
        dateFrom: '2026-01-01',
        dateTo: '2026-01-31',
      });

      const findCall = prisma.user.findMany.mock.calls[0][0];
      expect(findCall.where.createdAt).toBeDefined();
      expect(findCall.where.createdAt.gte).toEqual(new Date('2026-01-01'));
    });

    it('should apply suspended status filter', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.getUsers({ page: 1, limit: 10, status: 'suspended' });

      const findCall = prisma.user.findMany.mock.calls[0][0];
      expect(findCall.where.moderation).toEqual({ status: 'SUSPENDED' });
    });

    it('should normalize pagination (clamp limit to 100)', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.getUsers({ page: 1, limit: 500 });

      const findCall = prisma.user.findMany.mock.calls[0][0];
      expect(findCall.take).toBe(100);
    });
  });

  describe('getUserDetail()', () => {
    it('should use select without passwordHash', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: '1',
        email: 'a@b.com',
        username: 'alice',
        name: 'Alice',
        avatar: null,
        role: 'USER',
        verified: false,
        reputation: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        moderation: null,
        _count: { reviews: 0 },
      });

      const result = await service.getUserDetail('1', true);

      expect(result.user).not.toHaveProperty('passwordHash');
      const call = prisma.user.findUnique.mock.calls[0][0];
      expect(call.select).toBeDefined();
      expect(call.select.passwordHash).toBeUndefined();
    });

    it('should throw NotFoundException for missing user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getUserDetail('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return lazy response with deferred fields', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: '1',
        email: 'a@b.com',
        username: 'alice',
        name: null,
        avatar: null,
        role: 'USER',
        verified: false,
        reputation: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        moderation: null,
        _count: { reviews: 0 },
      });

      const result = await service.getUserDetail('1', true);

      expect(result.lazy).toBe(true);
      expect(result.deferred).toContain('metrics');
      expect(result.deferred).toContain('activitySeries');
      expect(result.user.name).toBe('alice'); // falls back to username
      expect(result.metrics).toBeNull();
    });

    it('should return full detail when not lazy', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: '1',
        email: 'a@b.com',
        username: 'alice',
        name: 'Alice',
        avatar: null,
        role: 'USER',
        verified: false,
        reputation: 0,
        registrationIp: null,
        registrationCountry: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-15'),
        moderation: null,
        _count: { reviews: 1 },
      });
      prisma.comment.count.mockResolvedValue(5);
      prisma.helpfulVote.count.mockResolvedValue(3);
      prisma.complaintVote.count.mockResolvedValue(2);
      prisma.commentVote.count.mockResolvedValue(1);
      prisma.review.findMany.mockResolvedValue([]);
      prisma.complaint.findMany.mockResolvedValue([]);
      prisma.post.findMany.mockResolvedValue([]);
      prisma.session.findMany.mockResolvedValue([]);
      prisma.comment.findMany.mockResolvedValue([]);
      prisma.helpfulVote.findMany.mockResolvedValue([]);

      const result = await service.getUserDetail('1', false);

      expect(result.metrics!.commentsCount).toBe(5);
      expect(result.metrics!.votesCount).toBe(6); // 3+2+1
      expect(result.activitySeries).toHaveLength(30);
      expect(result.user.loginCount).toBe(0);
    });

    it('should derive user fields from most recent session', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);
      prisma.user.findUnique.mockResolvedValue({
        id: '1',
        email: 'a@b.com',
        username: 'alice',
        name: 'Alice',
        avatar: null,
        role: 'USER',
        verified: false,
        reputation: 0,
        registrationIp: null,
        registrationCountry: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-15'),
        _count: { reviews: 0 },
      });
      prisma.comment.count.mockResolvedValue(0);
      prisma.helpfulVote.count.mockResolvedValue(0);
      prisma.complaintVote.count.mockResolvedValue(0);
      prisma.commentVote.count.mockResolvedValue(0);
      prisma.review.findMany.mockResolvedValue([]);
      prisma.complaint.findMany.mockResolvedValue([]);
      prisma.post.findMany.mockResolvedValue([]);
      prisma.session.findMany.mockResolvedValue([
        {
          createdAt: yesterday,
          ip: '10.0.0.1',
          ipHash: 'oldhash',
          device: 'mobile',
          browser: 'Firefox',
          os: 'Android',
          country: 'DE',
          timezone: 'Europe/Berlin',
          trigger: 'login',
        },
        {
          createdAt: now,
          ip: '192.168.1.1',
          ipHash: 'newhash',
          device: 'desktop',
          browser: 'Chrome',
          os: 'Windows',
          country: 'US',
          timezone: 'America/New_York',
          trigger: 'login',
        },
      ]);
      prisma.comment.findMany.mockResolvedValue([]);
      prisma.helpfulVote.findMany.mockResolvedValue([]);

      const result = await service.getUserDetail('1', false);

      // Most recent session fields
      expect(result.user.lastLoginIp).toBe('192.168.1.1');
      expect(result.user.device).toBe('desktop');
      expect(result.user.browser).toBe('Chrome');
      expect(result.user.os).toBe('Windows');
      expect(result.user.country).toBe('US');
      expect(result.user.timezone).toBe('America/New_York');
      expect(result.user.loginCount).toBe(2);
      // registrationIp falls back to earliest session when user field is null
      expect(result.user.registrationIp).toBe('10.0.0.1');
      expect(result.user.registrationCountry).toBe('DE');
    });

    it('should prefer user registrationIp/Country over earliest session', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: '1',
        email: 'a@b.com',
        username: 'alice',
        name: 'Alice',
        avatar: null,
        role: 'USER',
        verified: false,
        reputation: 0,
        registrationIp: '1.2.3.4',
        registrationCountry: 'GB',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-15'),
        _count: { reviews: 0 },
      });
      prisma.comment.count.mockResolvedValue(0);
      prisma.helpfulVote.count.mockResolvedValue(0);
      prisma.complaintVote.count.mockResolvedValue(0);
      prisma.commentVote.count.mockResolvedValue(0);
      prisma.review.findMany.mockResolvedValue([]);
      prisma.complaint.findMany.mockResolvedValue([]);
      prisma.post.findMany.mockResolvedValue([]);
      prisma.session.findMany.mockResolvedValue([
        {
          createdAt: new Date(),
          ip: '5.6.7.8',
          ipHash: 'hash',
          device: 'desktop',
          browser: 'Chrome',
          os: 'Linux',
          country: 'US',
          timezone: 'America/Chicago',
          trigger: 'login',
        },
      ]);
      prisma.comment.findMany.mockResolvedValue([]);
      prisma.helpfulVote.findMany.mockResolvedValue([]);

      const result = await service.getUserDetail('1', false);

      expect(result.user.registrationIp).toBe('1.2.3.4');
      expect(result.user.registrationCountry).toBe('GB');
    });

    it('should populate per-day device/country breakdowns in activitySeries', async () => {
      const today = new Date().toISOString().slice(0, 10);
      prisma.user.findUnique.mockResolvedValue({
        id: '1',
        email: 'a@b.com',
        username: 'alice',
        name: 'Alice',
        avatar: null,
        role: 'USER',
        verified: false,
        reputation: 0,
        registrationIp: null,
        registrationCountry: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-15'),
        _count: { reviews: 0 },
      });
      prisma.comment.count.mockResolvedValue(0);
      prisma.helpfulVote.count.mockResolvedValue(0);
      prisma.complaintVote.count.mockResolvedValue(0);
      prisma.commentVote.count.mockResolvedValue(0);
      prisma.review.findMany.mockResolvedValue([]);
      prisma.complaint.findMany.mockResolvedValue([]);
      prisma.post.findMany.mockResolvedValue([]);
      prisma.session.findMany.mockResolvedValue([
        {
          createdAt: new Date(),
          ip: '1.2.3.4',
          ipHash: 'h1',
          device: 'mobile',
          browser: 'Safari',
          os: 'iOS',
          country: 'JP',
          timezone: 'Asia/Tokyo',
          trigger: 'login',
        },
        {
          createdAt: new Date(),
          ip: '5.6.7.8',
          ipHash: 'h2',
          device: 'desktop',
          browser: 'Chrome',
          os: 'Windows',
          country: 'JP',
          timezone: 'Asia/Tokyo',
          trigger: 'login',
        },
      ]);
      prisma.comment.findMany.mockResolvedValue([]);
      prisma.helpfulVote.findMany.mockResolvedValue([]);

      const result = await service.getUserDetail('1', false);

      const todayEntry = result.activitySeries.find(
        (e: any) => e.date === today,
      ) as any;
      expect(todayEntry).toBeDefined();
      // Two sessions today: 1 mobile + 1 desktop — no clear winner, either is valid
      expect(['mobile', 'desktop']).toContain(todayEntry.device);
      expect(todayEntry.country).toBe('JP');
      expect(todayEntry.logins).toBe(2);

      // Days without sessions should show 'Unknown'
      const oldDay = result.activitySeries[0] as any;
      expect(oldDay.device).toBe('Unknown');
      expect(oldDay.country).toBe('Unknown');
    });

    it('should handle zero sessions gracefully', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: '1',
        email: 'a@b.com',
        username: 'alice',
        name: 'Alice',
        avatar: null,
        role: 'USER',
        verified: false,
        reputation: 0,
        registrationIp: null,
        registrationCountry: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-15'),
        _count: { reviews: 0 },
      });
      prisma.comment.count.mockResolvedValue(0);
      prisma.helpfulVote.count.mockResolvedValue(0);
      prisma.complaintVote.count.mockResolvedValue(0);
      prisma.commentVote.count.mockResolvedValue(0);
      prisma.review.findMany.mockResolvedValue([]);
      prisma.complaint.findMany.mockResolvedValue([]);
      prisma.post.findMany.mockResolvedValue([]);
      prisma.session.findMany.mockResolvedValue([]);
      prisma.comment.findMany.mockResolvedValue([]);
      prisma.helpfulVote.findMany.mockResolvedValue([]);

      const result = await service.getUserDetail('1', false);

      expect(result.user.lastLoginIp).toBeUndefined();
      expect(result.user.device).toBeUndefined();
      expect(result.user.loginCount).toBe(0);
      expect(result.user.registrationIp).toBeUndefined();
      expect(result.user.registrationCountry).toBeUndefined();
    });
  });

  describe('getComplaints()', () => {
    it('should return paginated complaints', async () => {
      prisma.complaint.findMany.mockResolvedValue([
        {
          id: 'c1',
          title: 'Missing funds',
          content: 'Details',
          author: {
            id: 'u1',
            username: 'alice',
            name: 'Alice',
            email: 'a@b.com',
          },
          company: null,
          product: { id: 'p1', name: 'WalletX' },
          productId: 'p1',
          companyId: null,
          reportCount: 4,
          status: 'OPEN',
          createdAt: new Date('2026-03-01'),
          updatedAt: new Date('2026-03-02'),
        },
      ]);
      prisma.complaint.count.mockResolvedValue(1);

      const result = await service.getComplaints({ page: 1, limit: 10 });

      expect(result.complaints).toHaveLength(1);
      expect((result.complaints[0] as any).subject).toBe('Missing funds');
      expect((result.complaints[0] as any).priority).toBe('medium');
      expect(result.pagination.total).toBe(1);
    });
  });

  describe('updateComplaintStatus()', () => {
    it('should update complaint status', async () => {
      prisma.complaint.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'OPEN',
      });
      prisma.complaint.update.mockResolvedValue({
        id: 'c1',
        status: 'RESOLVED',
      });

      const result = await service.updateComplaintStatus('c1', 'resolved');

      expect(prisma.complaint.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'RESOLVED' },
      });
      expect(result.complaint.status).toBe('resolved');
    });
  });

  describe('updateUserStatus()', () => {
    it('should upsert moderation status', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.userModeration.upsert.mockResolvedValue({
        status: 'SUSPENDED',
        reason: 'spam',
        updatedAt: new Date('2026-03-20T00:00:00.000Z'),
      });

      const result = await service.updateUserStatus('u1', 'suspended', 'spam');

      expect(prisma.userModeration.upsert).toHaveBeenCalled();
      expect(result.user.status).toBe('suspended');
      expect(result.user.moderationReason).toBe('spam');
    });
  });

  describe('getReviews()', () => {
    it('should return paginated reviews', async () => {
      prisma.review.findMany.mockResolvedValue([
        {
          id: 'r1',
          title: 'Great Exchange',
          content: 'A'.repeat(150),
          authorId: 'u1',
          author: { id: 'u1', username: 'alice', name: 'Alice' },
          product: null,
          company: { id: 'c1', name: 'ExchangeX', slug: 'exchangex' },
          productId: null,
          companyId: 'c1',
          overallScore: 8.5,
          helpfulCount: 10,
          status: 'APPROVED',
          createdAt: new Date('2026-03-01'),
          _count: { comments: 3 },
        },
      ]);
      prisma.review.count.mockResolvedValue(1);

      const result = await service.getReviews({ page: 1, limit: 10 });

      expect(result.reviews).toHaveLength(1);
      expect((result.reviews[0] as any).excerpt.length).toBeLessThanOrEqual(
        124,
      ); // 120 + "..."
      expect((result.reviews[0] as any).author).toBe('Alice');
      expect((result.reviews[0] as any).productName).toBe('ExchangeX');
      expect(result.pagination.total).toBe(1);
    });

    it('should filter by status', async () => {
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);

      await service.getReviews({
        page: 1,
        limit: 10,
        status: 'PENDING' as any,
      });

      const findCall = prisma.review.findMany.mock.calls[0][0];
      expect(findCall.where.status).toBe('PENDING');
    });

    it('should skip total count when includeTotal is false', async () => {
      prisma.review.findMany.mockResolvedValue([]);

      const result = await service.getReviews({
        page: 1,
        limit: 10,
        includeTotal: false,
      });

      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
      // review.count should not be called when includeTotal is false
      expect(prisma.review.count).not.toHaveBeenCalled();
    });
  });

  describe('getReview()', () => {
    it('should return lazy review with deferred fields', async () => {
      prisma.review.findUnique.mockResolvedValue({
        id: 'r1',
        title: 'Test',
        content: 'Content here',
        authorId: 'u1',
        author: { id: 'u1', username: 'alice', name: 'Alice' },
        product: null,
        company: null,
        productId: null,
        companyId: null,
        overallScore: 7,
        helpfulCount: 5,
        downVoteCount: 1,
        reportCount: 0,
        status: 'APPROVED',
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { comments: 0 },
      });

      const result = await service.getReview('r1', true);

      expect(result.lazy).toBe(true);
      expect(result.deferred).toContain('comments');
      expect(result.comments).toEqual([]);
      expect(result.helpfulVotes).toEqual([]);
    });

    it('should return full review with comments and reactions', async () => {
      prisma.review.findUnique.mockResolvedValue({
        id: 'r1',
        title: 'Test',
        content: 'Content here',
        authorId: 'u1',
        author: { id: 'u1', username: 'alice', name: null },
        product: null,
        company: null,
        productId: null,
        companyId: null,
        overallScore: 7,
        helpfulCount: 5,
        downVoteCount: 1,
        reportCount: 0,
        status: 'APPROVED',
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { comments: 1 },
        reactions: [{ type: 'like' }, { type: 'like' }, { type: 'fire' }],
        helpfulVotes: [{ userId: 'u2', voteType: 'UP', createdAt: new Date() }],
        comments: [
          {
            id: 'c1',
            content: 'Nice',
            authorId: 'u2',
            author: { id: 'u2', name: 'Bob', username: 'bob' },
            helpfulCount: 1,
            downVoteCount: 0,
            createdAt: new Date(),
            replies: [],
          },
        ],
      });

      const result = await service.getReview('r1', false);

      expect(result.author).toBe('alice'); // falls back to username when name is null
      expect(result.reactions).toEqual({ like: 2, fire: 1 });
      expect(result.helpfulVotes).toHaveLength(1);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].replyCount).toBe(0);
    });

    it('should throw NotFoundException for missing review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);
      await expect(service.getReview('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateReviewStatus()', () => {
    it('should update status and return result', async () => {
      prisma.review.findUnique.mockResolvedValue({
        id: 'r1',
        status: 'PENDING',
      });
      prisma.review.update.mockResolvedValue({ id: 'r1', status: 'APPROVED' });

      const result = await service.updateReviewStatus('r1', 'APPROVED' as any);

      expect(result.ok).toBe(true);
      expect(result.review.status).toBe('APPROVED');
    });

    it('should throw NotFoundException for missing review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);
      await expect(
        service.updateReviewStatus('missing', 'APPROVED' as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getRatings()', () => {
    it('should return empty ratings when no products', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      const result = await service.getRatings({ page: 1, limit: 10 });

      expect(result.ratings).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });

    it('should return ratings with aggregated review stats', async () => {
      prisma.product.findMany.mockResolvedValue([
        {
          id: 'p1',
          name: 'Product A',
          slug: 'product-a',
          category: 'EXCHANGES',
          company: { name: 'CompanyX' },
          _count: { reviews: 5 },
        },
      ]);
      prisma.product.count.mockResolvedValue(1);
      prisma.review.groupBy
        .mockResolvedValueOnce([
          {
            productId: 'p1',
            _avg: { overallScore: 8.5 },
            _count: 3,
            _max: { createdAt: new Date('2026-03-15') },
          },
        ])
        .mockResolvedValueOnce([{ productId: 'p1', _count: 2 }]);

      // Use different limit to avoid cache hit from previous test (module-level cache)
      const result = await service.getRatings({ page: 1, limit: 20 });

      expect(result.ratings).toHaveLength(1);
      expect((result.ratings[0] as any).productName).toBe('Product A');
      expect((result.ratings[0] as any).score).toBe(8.5);
      expect((result.ratings[0] as any).submittedBy).toBe('CompanyX');
      expect((result.ratings[0] as any).status).toBe('published');
      expect((result.ratings[0] as any).trend).toBe('up');
    });
  });

  describe('getUserSessions()', () => {
    it('should return paginated sessions with enrichment fields', async () => {
      prisma.session.findMany.mockResolvedValue([
        {
          id: 's1',
          createdAt: new Date('2026-03-20T10:00:00Z'),
          expiresAt: new Date('2026-04-20T10:00:00Z'),
          ip: '1.2.3.4',
          ipHash: 'abc123',
          userAgent: 'Mozilla/5.0',
          device: 'desktop',
          browser: 'Chrome',
          os: 'Windows',
          country: 'US',
          timezone: 'America/New_York',
          trigger: 'login',
        },
      ]);
      prisma.session.count.mockResolvedValue(1);

      const result = await service.getUserSessions('u1', 1, 10);

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].ipHash).toBe('abc123');
      expect(result.sessions[0].device).toBe('desktop');
      expect(result.sessions[0].country).toBe('US');
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.totalPages).toBe(1);
    });

    it('should normalize null fields to undefined', async () => {
      prisma.session.findMany.mockResolvedValue([
        {
          id: 's1',
          createdAt: new Date(),
          expiresAt: new Date(),
          ip: null,
          ipHash: null,
          userAgent: null,
          device: null,
          browser: null,
          os: null,
          country: null,
          timezone: null,
          trigger: null,
        },
      ]);
      prisma.session.count.mockResolvedValue(1);

      const result = await service.getUserSessions('u1', 1, 10);

      expect(result.sessions[0].ipHash).toBeUndefined();
      expect(result.sessions[0].device).toBeUndefined();
    });

    it('should respect pagination skip/take', async () => {
      prisma.session.findMany.mockResolvedValue([]);
      prisma.session.count.mockResolvedValue(25);

      const result = await service.getUserSessions('u1', 3, 10);

      expect(prisma.session.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(result.pagination.page).toBe(3);
      expect(result.pagination.totalPages).toBe(3);
    });
  });

  describe('getUserSessionsExport()', () => {
    it('should return CSV with UTF-8 BOM and correct headers', async () => {
      prisma.session.findMany.mockResolvedValue([
        {
          ipHash: 'hash1',
          userAgent: 'Mozilla/5.0',
          device: 'desktop',
          browser: 'Chrome',
          os: 'Windows',
          country: 'US',
          timezone: 'America/New_York',
          trigger: 'login',
          createdAt: new Date('2026-03-20T10:00:00.000Z'),
          expiresAt: new Date('2026-04-20T10:00:00.000Z'),
        },
      ]);

      const csv = await service.getUserSessionsExport('u1', 'csv');

      expect(typeof csv).toBe('string');
      expect((csv as string).startsWith('\uFEFF')).toBe(true);
      expect(csv).toContain(
        'IP Hash,User Agent,Device,Browser,OS,Country,Timezone,Trigger,Created At,Expires At',
      );
      expect(csv).toContain('hash1');
      expect(csv).toContain('2026-03-20T10:00:00.000Z');
    });

    it('should escape CSV values containing commas or quotes', async () => {
      prisma.session.findMany.mockResolvedValue([
        {
          ipHash: 'hash1',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) "quoted"',
          device: 'desktop',
          browser: 'Chrome',
          os: 'Windows',
          country: 'US',
          timezone: 'America/New_York',
          trigger: 'login',
          createdAt: new Date('2026-03-20T10:00:00.000Z'),
          expiresAt: new Date('2026-04-20T10:00:00.000Z'),
        },
      ]);

      const csv = (await service.getUserSessionsExport('u1', 'csv')) as string;

      // Quoted values with escaped internal quotes
      expect(csv).toContain('""quoted""');
    });

    it('should return JSON array for json format', async () => {
      prisma.session.findMany.mockResolvedValue([
        {
          ipHash: 'hash1',
          userAgent: null,
          device: null,
          browser: null,
          os: null,
          country: null,
          timezone: null,
          trigger: null,
          createdAt: new Date('2026-03-20T10:00:00.000Z'),
          expiresAt: new Date('2026-04-20T10:00:00.000Z'),
        },
      ]);

      const result = await service.getUserSessionsExport('u1', 'json');

      expect(Array.isArray(result)).toBe(true);
      expect((result as any[])[0].ipHash).toBe('hash1');
      expect((result as any[])[0].userAgent).toBe('');
    });

    it('should exclude raw IP from export (hash only)', async () => {
      prisma.session.findMany.mockResolvedValue([]);

      await service.getUserSessionsExport('u1', 'csv');

      const selectArg = prisma.session.findMany.mock.calls[0][0].select;
      expect(selectArg.ipHash).toBe(true);
      expect(selectArg.ip).toBeUndefined();
    });
  });

  describe('getUserActivity()', () => {
    it('should fan-out across 5 tables and merge sorted by createdAt desc', async () => {
      prisma.review.findMany.mockResolvedValue([
        {
          id: 'r1',
          title: 'Great',
          createdAt: new Date('2026-03-20T10:00:00Z'),
          product: { name: 'ProductA' },
          company: null,
        },
      ]);
      prisma.comment.findMany.mockResolvedValue([
        {
          id: 'c1',
          content: 'Nice review',
          createdAt: new Date('2026-03-21T10:00:00Z'),
        },
      ]);
      prisma.complaint.findMany.mockResolvedValue([]);
      prisma.helpfulVote.findMany.mockResolvedValue([]);
      prisma.follow.findMany.mockResolvedValue([
        {
          id: 'f1',
          createdAt: new Date('2026-03-19T10:00:00Z'),
          following: { username: 'bob', name: 'Bob' },
        },
      ]);

      const result = await service.getUserActivity('u1', 1, 10);

      expect(result.activities).toHaveLength(3);
      // Sorted desc by createdAt
      expect(result.activities[0].type).toBe('comment');
      expect(result.activities[1].type).toBe('review');
      expect(result.activities[2].type).toBe('follow');
      expect(result.activities[0].summary).toContain('Commented');
      expect(result.activities[1].summary).toContain('Reviewed');
      expect(result.activities[2].summary).toContain('Followed Bob');
    });

    it('should paginate in-memory after merge', async () => {
      const activities = Array.from({ length: 15 }, (_, i) => ({
        id: `r${i}`,
        title: `Review ${i}`,
        createdAt: new Date(2026, 2, 20, 10, 0, 0, 0),
        product: { name: 'P' },
        company: null,
      }));
      prisma.review.findMany.mockResolvedValue(activities);
      prisma.comment.findMany.mockResolvedValue([]);
      prisma.complaint.findMany.mockResolvedValue([]);
      prisma.helpfulVote.findMany.mockResolvedValue([]);
      prisma.follow.findMany.mockResolvedValue([]);

      const page1 = await service.getUserActivity('u1', 1, 10);
      expect(page1.activities).toHaveLength(10);
      expect(page1.pagination.total).toBe(15);
      expect(page1.pagination.totalPages).toBe(2);

      const page2 = await service.getUserActivity('u1', 2, 10);
      expect(page2.activities).toHaveLength(5);
    });

    it('should cap each sub-query at page * limit rows', async () => {
      prisma.review.findMany.mockResolvedValue([]);
      prisma.comment.findMany.mockResolvedValue([]);
      prisma.complaint.findMany.mockResolvedValue([]);
      prisma.helpfulVote.findMany.mockResolvedValue([]);
      prisma.follow.findMany.mockResolvedValue([]);

      await service.getUserActivity('u1', 2, 10);

      // Each sub-query should take at most page * limit = 20
      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
    });
  });

  describe('rollupAnalytics()', () => {
    it('should rollup a single date', async () => {
      const mockRollup = { rollupDay: jest.fn().mockResolvedValue(true) };
      const svc = new AdminService(
        prisma as unknown as PrismaService,
        redisService as unknown as RedisService,
        observability as unknown as ObservabilityService,
        mockRollup as any,
      );

      const result = await svc.rollupAnalytics({ date: '2026-03-20' });

      expect(mockRollup.rollupDay).toHaveBeenCalledWith('2026-03-20');
      expect(result.ok).toBe(true);
      expect(result.rolledUp).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('should rollup a date range chunked by 10', async () => {
      const mockRollup = { rollupDay: jest.fn().mockResolvedValue(true) };
      const svc = new AdminService(
        prisma as unknown as PrismaService,
        redisService as unknown as RedisService,
        observability as unknown as ObservabilityService,
        mockRollup as any,
      );

      const result = await svc.rollupAnalytics({
        from: '2026-03-01',
        to: '2026-03-15',
      });

      expect(mockRollup.rollupDay).toHaveBeenCalledTimes(15);
      expect(result.rolledUp).toBe(15);
      expect(result.errors).toBe(0);
    });

    it('should cap range at 365 days', async () => {
      const mockRollup = { rollupDay: jest.fn().mockResolvedValue(true) };
      const svc = new AdminService(
        prisma as unknown as PrismaService,
        redisService as unknown as RedisService,
        observability as unknown as ObservabilityService,
        mockRollup as any,
      );

      await svc.rollupAnalytics({
        from: '2025-01-01',
        to: '2026-12-31',
      });

      // 365 days + 1 (inclusive) = 366 days
      expect(mockRollup.rollupDay.mock.calls.length).toBeLessThanOrEqual(366);
    });

    it('should default to yesterday when no date/range provided', async () => {
      const mockRollup = { rollupDay: jest.fn().mockResolvedValue(false) };
      const svc = new AdminService(
        prisma as unknown as PrismaService,
        redisService as unknown as RedisService,
        observability as unknown as ObservabilityService,
        mockRollup as any,
      );

      const result = await svc.rollupAnalytics({});

      expect(mockRollup.rollupDay).toHaveBeenCalledTimes(1);
      expect(result.skipped).toBe(1);
      expect(result.rolledUp).toBe(0);
    });

    it('should return error when rollup service not available', async () => {
      const result = await service.rollupAnalytics({ date: '2026-03-20' });
      expect(result.ok).toBe(false);
    });

    it('should count errors from rejected rollupDay promises', async () => {
      const mockRollup = {
        rollupDay: jest
          .fn()
          .mockResolvedValueOnce(true) // day 1 success
          .mockRejectedValueOnce(new Error('fail')) // day 2 error
          .mockResolvedValueOnce(false), // day 3 skipped
      };
      const svc = new AdminService(
        prisma as unknown as PrismaService,
        redisService as unknown as RedisService,
        observability as unknown as ObservabilityService,
        mockRollup as any,
      );

      const result = await svc.rollupAnalytics({
        from: '2026-03-01',
        to: '2026-03-03',
      });

      expect(result.rolledUp).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(1);
    });
  });

  describe('cache behavior', () => {
    it('should return cached stats within TTL (30s)', async () => {
      prisma.user.count.mockResolvedValue(100);
      prisma.$queryRaw.mockResolvedValue([{ count: BigInt(42) }]);
      prisma.review.count.mockResolvedValue(50);
      prisma.product.count.mockResolvedValue(10);
      prisma.complaint.count.mockResolvedValue(7);

      // First call populates cache
      await service.getStats();
      const callCount = prisma.user.count.mock.calls.length;

      // Second call should hit cache — no new DB calls
      await service.getStats();
      expect(prisma.user.count.mock.calls.length).toBe(callCount);
    });

    it('should return cached getUsers result within TTL', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      // Use a unique param set to avoid cross-test cache hits
      const params = { page: 99, limit: 1 };
      await service.getUsers(params);
      const callCount = prisma.user.findMany.mock.calls.length;

      await service.getUsers(params);
      expect(prisma.user.findMany.mock.calls.length).toBe(callCount);
    });
  });
});
