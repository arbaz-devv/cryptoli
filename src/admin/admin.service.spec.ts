import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';

describe('AdminService', () => {
  let service: AdminService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new AdminService(prisma as unknown as PrismaService);
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
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-15'),
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
      expect(result.activitySeries).toHaveLength(7);
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
});
