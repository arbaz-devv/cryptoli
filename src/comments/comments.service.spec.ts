import { BadRequestException } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { RedisService } from '../redis/redis.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import { createSocketMock } from '../../test/helpers/socket.mock';
import { createRedisMock } from '../../test/helpers/redis.mock';

describe('CommentsService', () => {
  let service: CommentsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let socketMock: ReturnType<typeof createSocketMock>;
  let redisMock: ReturnType<typeof createRedisMock>;
  let notificationsMock: { createForUser: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaMock();
    socketMock = createSocketMock();
    redisMock = createRedisMock(false);
    notificationsMock = {
      createForUser: jest.fn().mockResolvedValue(undefined),
    };
    service = new CommentsService(
      prisma as unknown as PrismaService,
      notificationsMock as any,
      socketMock as any,
      redisMock as unknown as RedisService,
    );
  });

  describe('vote()', () => {
    it('should create a new UP vote via $transaction delta update', async () => {
      const txMock = {
        comment: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'cm1', authorId: 'author1' }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 1,
            downVoteCount: 0,
          }),
        },
        commentVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      // Mock the post-transaction lookups
      prisma.comment.findUnique.mockResolvedValue({ reviewId: 'r1' });
      prisma.user.findUnique.mockResolvedValue({ username: 'voter' });

      const result = await service.vote('cm1', 'UP', 'u1');

      expect(txMock.commentVote.create).toHaveBeenCalledWith({
        data: { userId: 'u1', commentId: 'cm1', voteType: 'UP' },
      });
      expect(result).toEqual({
        voteType: 'UP',
        helpfulCount: 1,
        downVoteCount: 0,
      });
    });

    it('should toggle off same vote (UP→delete)', async () => {
      const txMock = {
        comment: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'cm1', authorId: 'author1' }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 0,
            downVoteCount: 0,
          }),
        },
        commentVote: {
          findUnique: jest.fn().mockResolvedValue({ id: 'v1', voteType: 'UP' }),
          delete: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      const result = await service.vote('cm1', 'UP', 'u1');

      expect(txMock.commentVote.delete).toHaveBeenCalledWith({
        where: { id: 'v1' },
      });
      expect(result.voteType).toBeNull();
    });

    it('should switch vote (UP→DOWN)', async () => {
      const txMock = {
        comment: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'cm1', authorId: 'author1' }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 0,
            downVoteCount: 1,
          }),
        },
        commentVote: {
          findUnique: jest.fn().mockResolvedValue({ id: 'v1', voteType: 'UP' }),
          update: jest.fn(),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      const result = await service.vote('cm1', 'DOWN', 'u1');

      expect(txMock.commentVote.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { voteType: 'DOWN' },
      });
      expect(result).toEqual({
        voteType: 'DOWN',
        helpfulCount: 0,
        downVoteCount: 1,
      });
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

      await expect(service.vote('bad', 'UP', 'u1')).rejects.toThrow(
        NotFoundError,
      );
    });

    it('should send notification on new UP vote to different author', async () => {
      const txMock = {
        comment: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'cm1', authorId: 'author1' }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 1,
            downVoteCount: 0,
          }),
        },
        commentVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      };

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
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'cm1', authorId: 'u1' }),
          update: jest.fn().mockResolvedValue({
            helpfulCount: 1,
            downVoteCount: 0,
          }),
        },
        commentVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
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
      await expect(service.create({ content: 'test' }, 'u1')).rejects.toThrow(
        BadRequestException,
      );
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
        author: {
          id: 'u1',
          username: 'commenter',
          avatar: null,
          verified: false,
        },
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

    it('should notify parent comment author when replying (parentId set)', async () => {
      // Reply to someone else's comment on a review
      prisma.comment.create.mockResolvedValue({
        id: 'reply1',
        content: 'I agree!',
        authorId: 'replier',
        reviewId: 'r1',
        parentId: 'parent-cm',
        author: {
          id: 'replier',
          username: 'replier_user',
          avatar: null,
          verified: false,
        },
        _count: { reactions: 0, votes: 0, replies: 0 },
      });
      // First findUnique call: fetch parent's authorId
      // Second findUnique call: check if parent itself is a reply (parentId: null → top-level)
      prisma.comment.findUnique
        .mockResolvedValueOnce({ authorId: 'parent-author' }) // parent comment author
        .mockResolvedValueOnce({ parentId: null }); // parent is a top-level comment (not a reply)
      prisma.review.findUnique.mockResolvedValue({
        id: 'r1',
        title: 'My Review',
        authorId: 'review-author',
        author: { username: 'reviewer' },
      });
      prisma.comment.count.mockResolvedValue(3);

      await service.create(
        { content: 'I agree!', reviewId: 'r1', parentId: 'parent-cm' },
        'replier',
      );

      // Should notify the parent comment author (not the review author here — that's a separate call)
      expect(notificationsMock.createForUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'parent-author',
          type: 'NEW_COMMENT',
          title: 'New reply to your comment',
          message: expect.stringContaining(
            'replied to your comment on "My Review"',
          ),
        }),
      );
    });

    it('should send "replied to your reply" message for nested replies', async () => {
      prisma.comment.create.mockResolvedValue({
        id: 'nested-reply',
        content: 'Nested!',
        authorId: 'replier',
        reviewId: 'r1',
        parentId: 'mid-comment',
        author: {
          id: 'replier',
          username: 'deep_replier',
          avatar: null,
          verified: false,
        },
        _count: { reactions: 0, votes: 0, replies: 0 },
      });
      // Parent is itself a reply (has a parentId)
      prisma.comment.findUnique
        .mockResolvedValueOnce({ authorId: 'mid-author' }) // parent's author
        .mockResolvedValueOnce({ parentId: 'grandparent-id' }); // parent is a reply (isReplyToReply=true)
      prisma.review.findUnique.mockResolvedValue({
        id: 'r1',
        title: 'Some Review',
        authorId: 'review-author',
        author: { username: 'reviewer' },
      });
      prisma.comment.count.mockResolvedValue(5);

      await service.create(
        { content: 'Nested!', reviewId: 'r1', parentId: 'mid-comment' },
        'replier',
      );

      expect(notificationsMock.createForUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'mid-author',
          type: 'NEW_COMMENT',
          message: expect.stringContaining('replied to your reply'),
        }),
      );
    });

    it('should NOT notify parent author when replying to own comment', async () => {
      prisma.comment.create.mockResolvedValue({
        id: 'self-reply',
        content: 'Followup',
        authorId: 'self-user',
        reviewId: 'r1',
        parentId: 'own-cm',
        author: {
          id: 'self-user',
          username: 'self_user',
          avatar: null,
          verified: false,
        },
        _count: { reactions: 0, votes: 0, replies: 0 },
      });
      prisma.comment.findUnique.mockResolvedValue({ authorId: 'self-user' });
      prisma.review.findUnique.mockResolvedValue({
        id: 'r1',
        title: 'Test',
        authorId: 'other-author',
        author: { username: 'other' },
      });
      prisma.comment.count.mockResolvedValue(2);

      await service.create(
        { content: 'Followup', reviewId: 'r1', parentId: 'own-cm' },
        'self-user',
      );

      // Parent reply notification should NOT fire (self-reply)
      // But review author notification SHOULD fire (different author)
      const calls = notificationsMock.createForUser.mock.calls;
      const parentNotification = calls.find(
        (c: any) => c[0]?.title === 'New reply to your comment',
      );
      expect(parentNotification).toBeUndefined();
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
          createdAt: new Date(),
          _count: { reactions: 0, votes: 0, replies: 0 },
          helpfulCount: 1,
          downVoteCount: 0,
        },
      ]);
      prisma.comment.count.mockResolvedValue(1);
      prisma.commentVote.findMany.mockResolvedValue([
        { commentId: 'cm1', voteType: 'UP' },
      ]);

      const result = await service.list('r1', undefined, undefined, {
        id: 'u1',
      });

      expect((result.comments[0] as any).userVote).toBe('UP');
      expect(result.pagination.hasMore).toBe(false);
    });

    it('should return null userVote when no user', async () => {
      prisma.comment.findMany.mockResolvedValue([
        {
          id: 'cm1',
          createdAt: new Date(),
          _count: { reactions: 0, votes: 0, replies: 0 },
          helpfulCount: 0,
          downVoteCount: 0,
        },
      ]);
      prisma.comment.count.mockResolvedValue(1);

      const result = await service.list('r1');

      expect((result.comments[0] as any).userVote).toBeNull();
    });
  });

  describe('getById()', () => {
    it('should fall back to list when id === "list"', async () => {
      prisma.comment.findMany.mockResolvedValue([]);
      prisma.comment.count.mockResolvedValue(0);

      const result = await service.getById('list', 'r1');

      expect(result).toEqual({
        comments: [],
        pagination: { limit: 20, hasMore: false, nextCursor: null },
        totalCount: 0,
      });
    });

    it('should return single comment with replies', async () => {
      prisma.comment.findMany.mockResolvedValue([
        {
          id: 'cm1',
          content: 'Test',
          createdAt: new Date(),
          _count: { reactions: 0, votes: 0, replies: 0 },
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
