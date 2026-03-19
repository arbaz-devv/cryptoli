import { BadRequestException } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createPrismaMock } from '../../test/helpers/prisma.mock';

describe('CompaniesService', () => {
  let service: CompaniesService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new CompaniesService(prisma as unknown as PrismaService);
  });

  describe('list()', () => {
    it('should return paginated companies', async () => {
      prisma.company.findMany.mockResolvedValue([
        { id: 'c1', name: 'Exchange A' },
      ]);
      prisma.company.count.mockResolvedValue(1);

      const result = await service.list(1, 10);

      expect(result.companies).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });

    it('should filter by category', async () => {
      prisma.company.findMany.mockResolvedValue([]);
      prisma.company.count.mockResolvedValue(0);

      await service.list(1, 10, 'EXCHANGES');

      const findCall = prisma.company.findMany.mock.calls[0][0];
      expect(findCall.where.category).toBe('EXCHANGES');
    });

    it('should filter by search query', async () => {
      prisma.company.findMany.mockResolvedValue([]);
      prisma.company.count.mockResolvedValue(0);

      await service.list(1, 10, undefined, 'bitcoin');

      const findCall = prisma.company.findMany.mock.calls[0][0];
      expect(findCall.where.OR).toBeDefined();
    });
  });

  describe('getBySlug()', () => {
    it('should return company with computed averageScore', async () => {
      prisma.company.findUnique.mockResolvedValue({
        id: 'c1',
        name: 'Exchange',
        slug: 'exchange',
      });
      prisma.review.findMany.mockResolvedValue([
        { overallScore: 8 },
        { overallScore: 6 },
      ]);

      const result = await service.getBySlug('exchange');

      expect(result.averageScore).toBe(7);
      expect(result.viewerState).toEqual({ isFollowing: false });
    });

    it('should return averageScore 0 when no reviews', async () => {
      prisma.company.findUnique.mockResolvedValue({
        id: 'c1',
        name: 'Exchange',
        slug: 'exchange',
      });
      prisma.review.findMany.mockResolvedValue([]);

      const result = await service.getBySlug('exchange');

      expect(result.averageScore).toBe(0);
    });

    it('should throw NotFoundError for missing company', async () => {
      prisma.company.findUnique.mockResolvedValue(null);

      await expect(service.getBySlug('missing')).rejects.toThrow(NotFoundError);
    });

    it('should return isFollowing true when viewer follows the company', async () => {
      prisma.company.findUnique.mockResolvedValue({
        id: 'c1',
        name: 'Exchange',
        slug: 'exchange',
      });
      prisma.review.findMany.mockResolvedValue([]);
      prisma.companyFollow.findFirst.mockResolvedValue({ id: 'cf1' });

      const result = await service.getBySlug('exchange', 'user1');

      expect(result.viewerState).toEqual({ isFollowing: true });
    });

    it('should return isFollowing false when viewer does not follow', async () => {
      prisma.company.findUnique.mockResolvedValue({
        id: 'c1',
        name: 'Exchange',
        slug: 'exchange',
      });
      prisma.review.findMany.mockResolvedValue([]);
      prisma.companyFollow.findFirst.mockResolvedValue(null);

      const result = await service.getBySlug('exchange', 'user1');

      expect(result.viewerState).toEqual({ isFollowing: false });
    });
  });

  describe('followCompany()', () => {
    it('should create a company follow', async () => {
      prisma.company.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.companyFollow.create.mockResolvedValue({ id: 'cf1' });

      const result = await service.followCompany('user1', 'exchange');

      expect(result).toEqual({ following: true });
      expect(prisma.companyFollow.create).toHaveBeenCalledWith({
        data: { userId: 'user1', companyId: 'c1' },
      });
    });

    it('should treat duplicate follow as success', async () => {
      prisma.company.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.companyFollow.create.mockRejectedValue(
        new Error('Unique constraint'),
      );

      const result = await service.followCompany('user1', 'exchange');

      expect(result).toEqual({ following: true });
    });

    it('should throw NotFoundError for missing company', async () => {
      prisma.company.findUnique.mockResolvedValue(null);

      await expect(
        service.followCompany('user1', 'missing'),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('unfollowCompany()', () => {
    it('should delete the company follow', async () => {
      prisma.company.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.companyFollow.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.unfollowCompany('user1', 'exchange');

      expect(result).toEqual({ following: false });
      expect(prisma.companyFollow.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user1', companyId: 'c1' },
      });
    });

    it('should succeed even when not following', async () => {
      prisma.company.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.companyFollow.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.unfollowCompany('user1', 'exchange');

      expect(result).toEqual({ following: false });
    });

    it('should throw NotFoundError for missing company', async () => {
      prisma.company.findUnique.mockResolvedValue(null);

      await expect(
        service.unfollowCompany('user1', 'missing'),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
