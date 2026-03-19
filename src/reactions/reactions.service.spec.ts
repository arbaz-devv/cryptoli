import { BadRequestException } from '@nestjs/common';
import { ReactionsService } from './reactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createPrismaMock } from '../../test/helpers/prisma.mock';

describe('ReactionsService', () => {
  let service: ReactionsService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new ReactionsService(prisma as unknown as PrismaService);
  });

  describe('toggle()', () => {
    it('should create a reaction on a review', async () => {
      prisma.review.findUnique.mockResolvedValue({ id: 'r1' });
      prisma.reaction.findFirst.mockResolvedValue(null);
      prisma.reaction.create.mockResolvedValue({
        id: 'rx1',
        type: 'LIKE',
        userId: 'u1',
        reviewId: 'r1',
      });

      const result = await service.toggle('u1', {
        type: 'LIKE',
        reviewId: 'r1',
      });

      expect(result.action).toBe('created');
      expect(result).toHaveProperty('reaction');
    });

    it('should toggle off an existing reaction', async () => {
      prisma.review.findUnique.mockResolvedValue({ id: 'r1' });
      prisma.reaction.findFirst.mockResolvedValue({
        id: 'rx1',
        type: 'LIKE',
        userId: 'u1',
      });
      prisma.reaction.delete.mockResolvedValue({});

      const result = await service.toggle('u1', {
        type: 'LIKE',
        reviewId: 'r1',
      });

      expect(result.action).toBe('removed');
      expect(result.type).toBe('LIKE');
      expect(prisma.reaction.delete).toHaveBeenCalledWith({
        where: { id: 'rx1' },
      });
    });

    it('should create a reaction on a comment', async () => {
      prisma.comment.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.reaction.findFirst.mockResolvedValue(null);
      prisma.reaction.create.mockResolvedValue({
        id: 'rx2',
        type: 'LOVE',
        userId: 'u1',
        commentId: 'c1',
      });

      const result = await service.toggle('u1', {
        type: 'LOVE',
        commentId: 'c1',
      });

      expect(result.action).toBe('created');
    });

    it('should create a reaction on a complaint', async () => {
      prisma.complaint.findUnique.mockResolvedValue({ id: 'cp1' });
      prisma.reaction.findFirst.mockResolvedValue(null);
      prisma.reaction.create.mockResolvedValue({
        id: 'rx3',
        type: 'HELPFUL',
        userId: 'u1',
        complaintId: 'cp1',
      });

      const result = await service.toggle('u1', {
        type: 'HELPFUL',
        complaintId: 'cp1',
      });

      expect(result.action).toBe('created');
    });

    it('should create a reaction on a post', async () => {
      prisma.post.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.reaction.findFirst.mockResolvedValue(null);
      prisma.reaction.create.mockResolvedValue({
        id: 'rx4',
        type: 'DISLIKE',
        userId: 'u1',
        postId: 'p1',
      });

      const result = await service.toggle('u1', {
        type: 'DISLIKE',
        postId: 'p1',
      });

      expect(result.action).toBe('created');
    });

    it('should reject when no target is provided', async () => {
      await expect(
        service.toggle('u1', { type: 'LIKE' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when multiple targets are provided', async () => {
      await expect(
        service.toggle('u1', {
          type: 'LIKE',
          reviewId: 'r1',
          commentId: 'c1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundError for non-existent review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);

      await expect(
        service.toggle('u1', { type: 'LIKE', reviewId: 'missing' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError for non-existent comment', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(
        service.toggle('u1', { type: 'LIKE', commentId: 'missing' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError for non-existent complaint', async () => {
      prisma.complaint.findUnique.mockResolvedValue(null);

      await expect(
        service.toggle('u1', { type: 'LIKE', complaintId: 'missing' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError for non-existent post', async () => {
      prisma.post.findUnique.mockResolvedValue(null);

      await expect(
        service.toggle('u1', { type: 'LIKE', postId: 'missing' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should reject invalid reaction type', async () => {
      await expect(
        service.toggle('u1', { type: 'INVALID', reviewId: 'r1' }),
      ).rejects.toThrow();
    });
  });

  describe('remove()', () => {
    it('should delete own reaction by id', async () => {
      prisma.reaction.findUnique.mockResolvedValue({
        id: 'rx1',
        userId: 'u1',
        type: 'LIKE',
      });
      prisma.reaction.delete.mockResolvedValue({});

      const result = await service.remove('u1', 'rx1');

      expect(result).toEqual({ removed: true });
      expect(prisma.reaction.delete).toHaveBeenCalledWith({
        where: { id: 'rx1' },
      });
    });

    it('should throw NotFoundError for non-existent reaction', async () => {
      prisma.reaction.findUnique.mockResolvedValue(null);

      await expect(service.remove('u1', 'missing')).rejects.toThrow(
        NotFoundError,
      );
    });

    it('should reject removing another user reaction', async () => {
      prisma.reaction.findUnique.mockResolvedValue({
        id: 'rx1',
        userId: 'other-user',
        type: 'LIKE',
      });

      await expect(service.remove('u1', 'rx1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
