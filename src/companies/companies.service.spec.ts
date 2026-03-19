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

      expect(result.averageScore).toBe(7); // (8 + 6) / 2
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
  });
});
