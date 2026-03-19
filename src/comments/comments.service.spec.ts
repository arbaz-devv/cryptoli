import { BadRequestException } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import { createSocketMock } from '../../test/helpers/socket.mock';

describe('CommentsService', () => {
  let service: CommentsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let socketMock: ReturnType<typeof createSocketMock>;
  let notificationsMock: { createForUser: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaMock();
    socketMock = createSocketMock();
    notificationsMock = { createForUser: jest.fn().mockResolvedValue(undefined) };
    service = new CommentsService(
      prisma as unknown as PrismaService,
      notificationsMock as any,
      socketMock as any,
    );
  });

  describe('vote()', () => {
    it('should create a new UP vote via $transaction recount', async () => {
      const txMock = {
        comment: {
          findUnique: jest.fn().mockResolvedValue({ id: 'cm1', authorId: 'author1' }),
          update: jest.fn(),
        },
        commentVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.commentVote.count
        .mockResolvedValueOnce(1)  // UP
        .mockResolvedValueOnce(0); // DOWN

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      // Mock the post-transaction lookups
      prisma.comment.findUnique.mockResolvedValue({ reviewId: 'r1' });
      prisma.user.findUnique.mockResolvedValue({ username: 'voter' });

      const result = await service.vote('cm1', 'UP', 'u1');

      expect(txMock.commentVote.create).toHaveBeenCalledWith({
        data: { userId: 'u1', commentId: 'cm1', voteType: 'UP' },
      });
      expect(result).toEqual({ voteType: 'UP', helpfulCount: 1, downVoteCount: 0 });
    });

    it('should toggle off same vote (UP→delete)', async () => {
      const txMock = {
        comment: {
          findUnique: jest.fn().mockResolvedValue({ id: 'cm1', authorId: 'author1' }),
          update: jest.fn(),
        },
        commentVote: {
          findUnique: jest.fn().mockResolvedValue({ id: 'v1', voteType: 'UP' }),
          delete: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      const result = await service.vote('cm1', 'UP', 'u1');

      expect(txMock.commentVote.delete).toHaveBeenCalledWith({ where: { id: 'v1' } });
      expect(result.voteType).toBeNull();
    });

    it('should switch vote (UP→DOWN)', async () => {
      const txMock = {
        comment: {
          findUnique: jest.fn().mockResolvedValue({ id: 'cm1', authorId: 'author1' }),
          update: jest.fn(),
        },
        commentVote: {
          findUnique: jest.fn().mockResolvedValue({ id: 'v1', voteType: 'UP' }),
          update: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.commentVote.count
        .mockResolvedValueOnce(0)  // UP
        .mockResolvedValueOnce(1); // DOWN

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      const result = await service.vote('cm1', 'DOWN', 'u1');

      expect(txMock.commentVote.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { voteType: 'DOWN' },
      });
      expect(result).toEqual({ voteType: 'DOWN', helpfulCount: 0, downVoteCount: 1 });
    });

    it('should reject invalid voteType', async () => {
      await expect(service.vote('cm1', 'INVALID', 'u1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundError for missing comment', async () => {
      const txMock = {
        comment: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await expect(service.vote('bad', 'UP', 'u1')).rejects.toThrow(NotFoundError);
    });

    it('should send notification on new UP vote to different author', async () => {
      const txMock = {
        comment: {
          findUnique: jest.fn().mockResolvedValue({ id: 'cm1', authorId: 'author1' }),
          update: jest.fn(),
        },
        commentVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.commentVote.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      prisma.comment.findUnique.mockResolvedValue({ reviewId: 'r1' });
      prisma.user.findUnique.mockResolvedValue({ username: 'voter' });

      await service.vote('cm1', 'UP', 'u1');

      expect(notificationsMock.createForUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'author1',
          type: 'NEW_REACTION',
        }),
      );
    });

    it('should NOT send notification when voting on own comment', async () => {
      const txMock = {
        comment: {
          findUnique: jest.fn().mockResolvedValue({ id: 'cm1', authorId: 'u1' }),
          update: jest.fn(),
        },
        commentVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          count: jest.fn().mockResolvedValue(1),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.vote('cm1', 'UP', 'u1');

      expect(notificationsMock.createForUser).not.toHaveBeenCalled();
    });
  });

  describe('create()', () => {
    it('should create comment and emit socket event for review comments', async () => {
      const comment = {
        id: 'cm1',
        content: 'Great review!',
        authorId: 'u1',
        reviewId: 'r1',
        author: { id: 'u1', username: 'user1', avatar: null, verified: false },
        _count: { reactions: 0, votes: 0, replies: 0 },
      };
      prisma.comment.create.mockResolvedValue(comment);
      prisma.review.findUnique.mockResolvedValue({
        id: 'r1',
        title: 'Review',
        authorId: 'r-author',
        author: { username: 'reviewer' },
      });
      prisma.comment.count.mockResolvedValue(5);

      const result = await service.create(
        { content: 'Great review!', reviewId: 'r1' },
        'u1',
      );

      expect(result.id).toBe('cm1');
      expect(socketMock.emitCommentCountUpdated).toHaveBeenCalledWith('r1', 5);
    });

    it('should enforce exactly one target (reviewId/postId/complaintId)', async () => {
      await expect(
        service.create({ content: 'test' }, 'u1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject multiple targets', async () => {
      await expect(
        service.create(
          { content: 'test', reviewId: 'r1', complaintId: 'c1' },
          'u1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should notify review author when commenting on their review', async () => {
      prisma.comment.create.mockResolvedValue({
        id: 'cm1',
        content: 'Nice!',
        authorId: 'u1',
        author: { id: 'u1', username: 'commenter', avatar: null, verified: false },
        _count: { reactions: 0, votes: 0, replies: 0 },
      });
      prisma.review.findUnique.mockResolvedValue({
        id: 'r1',
        title: 'Test Review',
        authorId: 'r-author',
        author: { username: 'reviewer' },
      });
      prisma.comment.count.mockResolvedValue(1);

      await service.create({ content: 'Nice!', reviewId: 'r1' }, 'u1');

      expect(notificationsMock.createForUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'r-author',
          type: 'NEW_COMMENT',
        }),
      );
    });

    it('should NOT notify review author when commenting on own review', async () => {
      prisma.comment.create.mockResolvedValue({
        id: 'cm1',
        content: 'Nice!',
        authorId: 'r-author',
        author: { id: 'r-author', username: 'reviewer' },
        _count: { reactions: 0, votes: 0, replies: 0 },
      });
      prisma.review.findUnique.mockResolvedValue({
        id: 'r1',
        title: 'Test Review',
        authorId: 'r-author',
        author: { username: 'reviewer' },
      });
      prisma.comment.count.mockResolvedValue(1);

      await service.create({ content: 'Nice!', reviewId: 'r1' }, 'r-author');

      expect(notificationsMock.createForUser).not.toHaveBeenCalled();
    });
  });

  describe('list()', () => {
    it('should return comments with userVote enrichment', async () => {
      prisma.comment.findMany.mockResolvedValue([
        {
          id: 'cm1',
          replies: [{ id: 'cm2' }],
          helpfulCount: 1,
          downVoteCount: 0,
        },
      ]);
      prisma.commentVote.findMany.mockResolvedValue([
        { commentId: 'cm1', voteType: 'UP' },
      ]);

      const result = await service.list('r1', undefined, undefined, { id: 'u1' });

      expect((result.comments[0] as any).userVote).toBe('UP');
      expect((result.comments[0].replies[0] as any).userVote).toBeNull();
    });

    it('should return null userVote when no user', async () => {
      prisma.comment.findMany.mockResolvedValue([
        {
          id: 'cm1',
          replies: [],
          helpfulCount: 0,
          downVoteCount: 0,
        },
      ]);

      const result = await service.list('r1');

      expect((result.comments[0] as any).userVote).toBeNull();
    });
  });

  describe('getById()', () => {
    it('should fall back to list when id === "list"', async () => {
      prisma.comment.findMany.mockResolvedValue([]);

      const result = await service.getById('list', 'r1');

      expect(result).toEqual({ comments: [] });
    });

    it('should return single comment with replies', async () => {
      prisma.comment.findMany.mockResolvedValue([
        {
          id: 'cm1',
          content: 'Test',
          replies: [],
        },
      ]);

      const result = await service.getById('cm1', 'r1');

      expect(result).toBeDefined();
      expect((result as any).id).toBe('cm1');
    });

    it('should return null when comment not found', async () => {
      prisma.comment.findMany.mockResolvedValue([]);

      const result = await service.getById('bad-id');

      expect(result).toBeNull();
    });
  });
});
