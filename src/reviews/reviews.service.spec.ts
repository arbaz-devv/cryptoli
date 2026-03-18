import { Test, TestingModule } from '@nestjs/testing';
import { ReviewsService } from './reviews.service';
import { PrismaService } from '../prisma/prisma.service';
import { SocketService } from '../socket/socket.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotFoundError } from '../common/errors';

describe('ReviewsService', () => {
  let service: ReviewsService;
  let prisma: {
    $transaction: jest.Mock;
    review: { findUnique: jest.Mock };
    helpfulVote: { findUnique: jest.Mock };
  };
  let socketService: { emitReviewVoteUpdated: jest.Mock };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(),
      review: { findUnique: jest.fn() },
      helpfulVote: { findUnique: jest.fn() },
    };

    socketService = {
      emitReviewVoteUpdated: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SocketService, useValue: socketService },
        { provide: NotificationsService, useValue: {} },
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
});
