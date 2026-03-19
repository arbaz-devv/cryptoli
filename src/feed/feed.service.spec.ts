import { FeedService } from './feed.service';
import { PrismaService } from '../prisma/prisma.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';

describe('FeedService', () => {
  let service: FeedService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new FeedService(prisma as unknown as PrismaService);
  });

  describe('getFeed()', () => {
    it('should merge reviews and complaints by createdAt desc', async () => {
      prisma.review.count.mockResolvedValue(2);
      prisma.complaint.count.mockResolvedValue(1);
      prisma.review.findMany
        .mockResolvedValueOnce([
          { id: 'r1', title: 'Review 1', createdAt: new Date('2026-03-19T12:00:00Z') },
          { id: 'r2', title: 'Review 2', createdAt: new Date('2026-03-19T10:00:00Z') },
        ])
        .mockResolvedValue([]);
      prisma.complaint.findMany
        .mockResolvedValueOnce([
          { id: 'c1', title: 'Complaint 1', createdAt: new Date('2026-03-19T11:00:00Z') },
        ])
        .mockResolvedValue([]);

      const result = await service.getFeed(1, 10);

      expect(result.items).toHaveLength(3);
      expect(result.items[0].id).toBe('r1'); // newest
      expect(result.items[1].id).toBe('c1'); // middle
      expect(result.items[2].id).toBe('r2'); // oldest
      expect(result.items[0].type).toBe('review');
      expect(result.items[1].type).toBe('complaint');
    });

    it('should filter by APPROVED status for reviews', async () => {
      prisma.review.count.mockResolvedValue(0);
      prisma.complaint.count.mockResolvedValue(0);
      prisma.review.findMany.mockResolvedValue([]);
      prisma.complaint.findMany.mockResolvedValue([]);

      await service.getFeed(1, 10);

      const reviewCountCall = prisma.review.count.mock.calls[0][0];
      expect(reviewCountCall.where.status).toBe('APPROVED');
    });

    it('should return empty items when no data', async () => {
      prisma.review.count.mockResolvedValue(0);
      prisma.complaint.count.mockResolvedValue(0);

      const result = await service.getFeed(1, 10);

      expect(result.items).toEqual([]);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
    });

    it('should support pagination', async () => {
      prisma.review.count.mockResolvedValue(5);
      prisma.complaint.count.mockResolvedValue(0);
      prisma.review.findMany
        .mockResolvedValueOnce(
          Array.from({ length: 5 }, (_, i) => ({
            id: `r${i}`,
            createdAt: new Date(Date.now() - i * 1000),
          })),
        )
        .mockResolvedValue([]);
      prisma.complaint.findMany.mockResolvedValue([]);

      const result = await service.getFeed(1, 3);

      expect(result.items.length).toBeLessThanOrEqual(3);
      expect(result.pagination.totalPages).toBe(2);
    });
  });
});
