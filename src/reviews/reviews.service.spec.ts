import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ReviewsService } from './reviews.service';
import { PrismaService } from '../prisma/prisma.service';
import { SocketService } from '../socket/socket.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotFoundError } from '../common/errors';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import { createSocketMock } from '../../test/helpers/socket.mock';

describe('ReviewsService', () => {
  let service: ReviewsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let socketService: ReturnType<typeof createSocketMock>;
  let notificationsMock: { createForUser: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    socketService = createSocketMock();
    notificationsMock = {
      createForUser: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SocketService, useValue: socketService },
        { provide: NotificationsService, useValue: notificationsMock },
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

    it('should recount votes inside the transaction (not use increment/decrement)', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({ id: 'review-1' }),
          update: jest.fn(),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.helpfulVote.count
        .mockResolvedValueOnce(1) // UP count
        .mockResolvedValueOnce(0); // DOWN count

      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      );

      await service.helpful('review-1', 'user-1');

      // Verify recount pattern: count both UP and DOWN
      expect(txMock.helpfulVote.count).toHaveBeenCalledWith({
        where: { reviewId: 'review-1', voteType: 'UP' },
      });
      expect(txMock.helpfulVote.count).toHaveBeenCalledWith({
        where: { reviewId: 'review-1', voteType: 'DOWN' },
      });

      // Verify update uses absolute counts, not increment/decrement
      expect(txMock.review.update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: { helpfulCount: 1, downVoteCount: 0 },
      });
    });

    it('should create a vote when none exists and return helpful: true', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({ id: 'review-1' }),
          update: jest.fn(),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
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
          update: jest.fn(),
        },
        helpfulVote: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'vote-1', userId: 'user-1' }),
          delete: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
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

  describe('vote()', () => {
    it('should create a new UP vote and recount', async () => {
      const txMock = {
        review: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'r1',
            title: 'Test',
            authorId: 'author1',
          }),
          update: jest.fn(),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'voter' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.helpfulVote.count
        .mockResolvedValueOnce(1) // UP
        .mockResolvedValueOnce(0); // DOWN

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
          update: jest.fn(),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'voter' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue({ id: 'v1', voteType: 'UP' }),
          delete: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
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
          update: jest.fn(),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'voter' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue({ id: 'v1', voteType: 'UP' }),
          update: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.helpfulVote.count
        .mockResolvedValueOnce(0) // UP
        .mockResolvedValueOnce(1); // DOWN

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
          update: jest.fn(),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'voter' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.helpfulVote.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

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
          update: jest.fn(),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ username: 'author' }),
        },
        helpfulVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.helpfulVote.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

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
        { id: 'r1', title: 'Review 1' },
        { id: 'r2', title: 'Review 2' },
      ]);
      prisma.review.count.mockResolvedValue(2);
      prisma.helpfulVote.findMany.mockResolvedValue([
        { reviewId: 'r1', voteType: 'UP' },
      ]);

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
});
