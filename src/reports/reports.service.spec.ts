import { BadRequestException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createPrismaMock } from '../../test/helpers/prisma.mock';

describe('ReportsService', () => {
  let service: ReportsService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new ReportsService(prisma as unknown as PrismaService);
  });

  describe('create()', () => {
    it('should create a report on a review and update reportCount', async () => {
      prisma.review.findUnique.mockResolvedValue({ id: 'r1' });
      prisma.report.create.mockResolvedValue({
        id: 'rp1',
        reporterId: 'u1',
        reviewId: 'r1',
        reason: 'spam',
      });
      prisma.report.count.mockResolvedValue(3);
      prisma.review.update.mockResolvedValue({});

      const result = await service.create('u1', {
        reason: 'spam',
        reviewId: 'r1',
      });

      expect(result.report.id).toBe('rp1');
      expect(prisma.report.count).toHaveBeenCalledWith({
        where: { reviewId: 'r1' },
      });
      expect(prisma.review.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { reportCount: 3 },
      });
    });

    it('should create a report on a complaint and update reportCount', async () => {
      prisma.complaint.findUnique.mockResolvedValue({ id: 'cp1' });
      prisma.report.create.mockResolvedValue({
        id: 'rp2',
        reporterId: 'u1',
        complaintId: 'cp1',
        reason: 'inappropriate',
      });
      prisma.report.count.mockResolvedValue(1);
      prisma.complaint.update.mockResolvedValue({});

      const result = await service.create('u1', {
        reason: 'inappropriate',
        complaintId: 'cp1',
      });

      expect(result.report.id).toBe('rp2');
      expect(prisma.complaint.update).toHaveBeenCalledWith({
        where: { id: 'cp1' },
        data: { reportCount: 1 },
      });
    });

    it('should create a report on a comment without updating reportCount', async () => {
      prisma.comment.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.report.create.mockResolvedValue({
        id: 'rp3',
        reporterId: 'u1',
        commentId: 'c1',
        reason: 'harassment',
      });

      const result = await service.create('u1', {
        reason: 'harassment',
        commentId: 'c1',
      });

      expect(result.report.id).toBe('rp3');
      // Comment has no reportCount — no update call
      expect(prisma.review.update).not.toHaveBeenCalled();
      expect(prisma.complaint.update).not.toHaveBeenCalled();
    });

    it('should reject when no target is provided', async () => {
      await expect(
        service.create('u1', { reason: 'spam' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when multiple targets are provided', async () => {
      await expect(
        service.create('u1', {
          reason: 'spam',
          reviewId: 'r1',
          commentId: 'c1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundError for non-existent review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);

      await expect(
        service.create('u1', { reason: 'spam', reviewId: 'missing' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError for non-existent comment', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(
        service.create('u1', { reason: 'spam', commentId: 'missing' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError for non-existent complaint', async () => {
      prisma.complaint.findUnique.mockResolvedValue(null);

      await expect(
        service.create('u1', { reason: 'spam', complaintId: 'missing' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should reject empty reason', async () => {
      await expect(
        service.create('u1', { reason: '', reviewId: 'r1' }),
      ).rejects.toThrow();
    });
  });
});
