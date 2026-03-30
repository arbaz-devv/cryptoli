import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ReviewsService } from './reviews.service';
import { PrismaService } from '../prisma/prisma.service';
import { SocketService } from '../socket/socket.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { NotFoundError } from '../common/errors';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import { createSocketMock } from '../../test/helpers/socket.mock';
import type { AnalyticsContext } from '../analytics/analytics-context';

describe('ReviewsService', () => {
  let service: ReviewsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let socketService: ReturnType<typeof createSocketMock>;
  let notificationsMock: { createForUser: jest.Mock };
  let analyticsMock: { track: jest.Mock };

  const mockCtx: AnalyticsContext = {
    ip: '1.2.3.4',
    userAgent: 'Mozilla/5.0 TestBrowser',
    country: 'US',
  };

  beforeEach(async () => {
    prisma = createPrismaMock();
    socketService = createSocketMock();
    notificationsMock = {
      createForUser: jest.fn().mockResolvedValue(undefined),
    };
    analyticsMock = {
      track: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SocketService, useValue: socketService },
        { provide: NotificationsService, useValue: notificationsMock },
        { provide: AnalyticsService, useValue: analyticsMock },
      ],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
  });

  describe('helpful()', () => {
    it('should use $transaction for atomicity', async () => {
      prisma.$transaction.mockResolvedValue({
        helpful: true,
        helpfulCount: 1,
        downVoteCount: 0,
      });

      await service.helpful('review-1', 'user-1');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should apply delta counter update inside transaction', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({ id: 'review-1' }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 1,
            downVoteCount: 0,
          }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      );

      await service.helpful('review-1', 'user-1');

      expect(txMock.review.update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: { helpfulCount: { increment: 1 } },
        select: { helpfulCount: true, downVoteCount: true },
      });
    });

    it('should create a vote when none exists and return helpful: true', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({ id: 'review-1' }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 1,
            downVoteCount: 0,
          }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      );

      const result = await service.helpful('review-1', 'user-1');

      expect(txMock.helpfulVote.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', reviewId: 'review-1' },
      });
      expect(result).toEqual({ helpful: true });
    });

    it('should delete existing vote and return helpful: false', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({ id: 'review-1' }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 0,
            downVoteCount: 0,
          }),
        },
        helpfulVote: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'vote-1', userId: 'user-1' }),
          delete: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      );

      const result = await service.helpful('review-1', 'user-1');

      expect(txMock.helpfulVote.delete).toHaveBeenCalledWith({
        where: { id: 'vote-1' },
      });
      expect(result).toEqual({ helpful: false });
    });

    it('should throw NotFoundError when review does not exist', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };

      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      );

      await expect(service.helpful('bad-id', 'user-1')).rejects.toThrow(
        NotFoundError,
      );
    });

    it('should emit socket events AFTER the transaction', async () => {
      prisma.$transaction.mockResolvedValue({
        helpful: true,
        helpfulCount: 3,
        downVoteCount: 1,
      });

      await service.helpful('review-1', 'user-1');

      expect(socketService.emitReviewVoteUpdated).toHaveBeenCalledWith(
        'review-1',
        3,
        1,
      );
    });
  });

  describe('list()', () => {
    it('should return paginated reviews with userVote from the main list query', async () => {
      prisma.review.findMany.mockResolvedValue([
        { id: 'r1', title: 'One', helpfulVotes: [{ voteType: 'UP' }] },
        { id: 'r2', title: 'Two', helpfulVotes: [] },
      ]);
      prisma.review.count.mockResolvedValue(2);

      const result = await service.list(
        1,
        10,
        undefined,
        undefined,
        undefined,
        'APPROVED',
        { id: 'u1' },
      );

      expect(result.reviews).toHaveLength(2);
      expect((result.reviews[0] as any).userVote).toBe('UP');
      expect((result.reviews[1] as any).userVote).toBeNull();
      expect(prisma.helpfulVote.findMany).not.toHaveBeenCalled();
      expect(result.pagination.total).toBe(2);
    });

    it('should return null userVote when viewer is anonymous', async () => {
      prisma.review.findMany.mockResolvedValue([{ id: 'r1', title: 'One' }]);
      prisma.review.count.mockResolvedValue(1);

      const result = await service.list(
        1,
        10,
        undefined,
        undefined,
        undefined,
        'APPROVED',
        null,
      );

      expect((result.reviews[0] as any).userVote).toBeNull();
    });
  });

  describe('vote()', () => {
    it('should create a new UP vote and recount', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'r1',
            title: 'Test',
            authorId: 'author1',
          }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 1,
            downVoteCount: 0,
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'voter' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      const result = await service.vote('r1', 'UP', 'u1');

      expect(txMock.helpfulVote.create).toHaveBeenCalledWith({
        data: { userId: 'u1', reviewId: 'r1', voteType: 'UP' },
      });
      expect(socketService.emitReviewVoteUpdated).toHaveBeenCalledWith(
        'r1',
        1,
        0,
      );
      expect(result.voteType).toBe('UP');
    });

    it('should toggle off same vote (UP→delete)', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'r1',
            title: 'Test',
            authorId: 'author1',
          }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 0,
            downVoteCount: 0,
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'voter' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue({ id: 'v1', voteType: 'UP' }),
          delete: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      const result = await service.vote('r1', 'UP', 'u1');

      expect(txMock.helpfulVote.delete).toHaveBeenCalledWith({
        where: { id: 'v1' },
      });
      expect(result.voteType).toBeNull();
    });

    it('should switch vote (UP→DOWN)', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'r1',
            title: 'Test',
            authorId: 'author1',
          }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 0,
            downVoteCount: 1,
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'voter' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue({ id: 'v1', voteType: 'UP' }),
          update: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      const result = await service.vote('r1', 'DOWN', 'u1');

      expect(txMock.helpfulVote.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { voteType: 'DOWN' },
      });
      expect(result.voteType).toBe('DOWN');
    });

    it('should reject invalid voteType', async () => {
      await expect(service.vote('r1', 'INVALID', 'u1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundError for missing review', async () => {
      const txMock = {
        review: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await expect(service.vote('bad', 'UP', 'u1')).rejects.toThrow(
        NotFoundError,
      );
    });

    it('should notify review author when different user votes', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'r1',
            title: 'Test',
            authorId: 'author1',
          }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 1,
            downVoteCount: 0,
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'voter' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.vote('r1', 'UP', 'voter1');

      expect(notificationsMock.createForUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'author1',
          type: 'NEW_REACTION',
        }),
      );
    });

    it('should NOT notify when voting on own review', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'r1',
            title: 'Test',
            authorId: 'author1',
          }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 1,
            downVoteCount: 0,
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'author' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.vote('r1', 'UP', 'author1');

      expect(notificationsMock.createForUser).not.toHaveBeenCalled();
    });
  });

  describe('create()', () => {
    it('should create review with APPROVED status and emit socket event', async () => {
      const review = {
        id: 'r1',
        title: 'Great Exchange',
        content: 'This is a detailed review with enough content.',
        status: 'APPROVED',
        overallScore: 7.5,
        author: { id: 'u1', username: 'user1' },
      };
      prisma.review.create.mockResolvedValue(review);

      const result = await service.create(
        {
          title: 'Great Exchange',
          content:
            'This is a detailed review with enough content for validation.',
          overallScore: 7.5,
          criteriaScores: { security: 8, easeOfUse: 7 },
        },
        'u1',
      );

      expect(result.status).toBe('APPROVED');
      expect(socketService.emitReviewCreated).toHaveBeenCalledWith(review);
    });

    it('should reject invalid body via Zod', async () => {
      await expect(
        service.create({ title: 'Hi', content: 'short' }, 'u1'),
      ).rejects.toThrow();
    });
  });

  describe('getById()', () => {
    it('should throw NotFoundError for missing review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);

      await expect(service.getById('bad')).rejects.toThrow(NotFoundError);
    });

    it('should return review with comments', async () => {
      prisma.review.findUnique.mockResolvedValue({
        id: 'r1',
        title: 'Test',
        comments: [{ id: 'cm1' }],
      });

      const result = await service.getById('r1');
      expect(result.id).toBe('r1');
      expect(result.comments).toHaveLength(1);
    });
  });

  describe('list()', () => {
    it('should return paginated reviews with userVote enrichment', async () => {
      prisma.review.findMany.mockResolvedValue([
        { id: 'r1', title: 'Review 1', helpfulVotes: [{ voteType: 'UP' }] },
        { id: 'r2', title: 'Review 2', helpfulVotes: [] },
      ]);
      prisma.review.count.mockResolvedValue(2);

      const result = await service.list(
        1,
        10,
        undefined,
        undefined,
        undefined,
        'APPROVED',
        { id: 'u1' },
      );

      expect(result.reviews).toHaveLength(2);
      expect((result.reviews[0] as any).userVote).toBe('UP');
      expect((result.reviews[1] as any).userVote).toBeNull();
      expect(prisma.helpfulVote.findMany).not.toHaveBeenCalled();
      expect(result.pagination.total).toBe(2);
    });

    it('should return null userVote for all when no user', async () => {
      prisma.review.findMany.mockResolvedValue([{ id: 'r1' }]);
      prisma.review.count.mockResolvedValue(1);

      const result = await service.list(
        1,
        10,
        undefined,
        undefined,
        undefined,
        'APPROVED',
        null,
      );

      expect((result.reviews[0] as any).userVote).toBeNull();
    });
  });

  describe('server-side analytics tracking', () => {
    it('should track review_created after create()', async () => {
      const review = {
        id: 'r1',
        title: 'Great Exchange',
        content: 'Detailed review content.',
        status: 'APPROVED',
        overallScore: 7.5,
        author: { id: 'u1', username: 'user1' },
      };
      prisma.review.create.mockResolvedValue(review);

      await service.create(
        {
          title: 'Great Exchange',
          content:
            'This is a detailed review with enough content for validation.',
          overallScore: 7.5,
          criteriaScores: { security: 8, easeOfUse: 7 },
          companyId: 'comp1',
        },
        'u1',
        mockCtx,
      );

      expect(analyticsMock.track).toHaveBeenCalledWith(
        '1.2.3.4',
        'Mozilla/5.0 TestBrowser',
        expect.objectContaining({
          event: 'review_created',
          consent: true,
          userId: 'u1',
          properties: { reviewId: 'r1', companyId: 'comp1' },
        }),
        'US',
      );
    });

    it('should track vote_cast after vote()', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'r1',
            title: 'Test',
            authorId: 'author1',
          }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 1,
            downVoteCount: 0,
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'voter' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.vote('r1', 'UP', 'u1', mockCtx);

      expect(analyticsMock.track).toHaveBeenCalledWith(
        '1.2.3.4',
        'Mozilla/5.0 TestBrowser',
        expect.objectContaining({
          event: 'vote_cast',
          consent: true,
          userId: 'u1',
          properties: { reviewId: 'r1', voteType: 'UP' },
        }),
        'US',
      );
    });

    it('should track vote_cast after helpful()', async () => {
      prisma.$transaction.mockResolvedValue({
        helpful: true,
        helpfulCount: 1,
        downVoteCount: 0,
      });

      await service.helpful('review-1', 'user-1', mockCtx);

      expect(analyticsMock.track).toHaveBeenCalledWith(
        '1.2.3.4',
        'Mozilla/5.0 TestBrowser',
        expect.objectContaining({
          event: 'vote_cast',
          consent: true,
          userId: 'user-1',
          properties: { reviewId: 'review-1', helpful: true },
        }),
        'US',
      );
    });

    it('should not track when analyticsCtx is not provided', async () => {
      const review = {
        id: 'r1',
        title: 'Great Exchange',
        content: 'Detailed review content.',
        status: 'APPROVED',
        overallScore: 7.5,
        author: { id: 'u1', username: 'user1' },
      };
      prisma.review.create.mockResolvedValue(review);

      await service.create(
        {
          title: 'Great Exchange',
          content:
            'This is a detailed review with enough content for validation.',
          overallScore: 7.5,
          criteriaScores: { security: 8, easeOfUse: 7 },
        },
        'u1',
      );

      expect(analyticsMock.track).not.toHaveBeenCalled();
    });
  });
});
