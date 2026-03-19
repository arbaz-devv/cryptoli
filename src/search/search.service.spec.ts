import { SearchService } from './search.service';
import { PrismaService } from '../prisma/prisma.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';

describe('SearchService', () => {
  let service: SearchService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new SearchService(prisma as unknown as PrismaService);
  });

  it('should return empty results for empty query', async () => {
    const result = await service.search('', 'all', 10);
    expect(result.results).toEqual({});
  });

  it('should search all entity types when type is "all"', async () => {
    prisma.company.findMany.mockResolvedValue([
      { id: 'c1', name: 'Bitcoin Exchange' },
    ]);
    prisma.review.findMany.mockResolvedValue([
      { id: 'r1', title: 'Bitcoin Review' },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', username: 'bitcoinfan' },
    ]);

    const result = await service.search('bitcoin', 'all', 10);

    expect(result.results.companies).toBeDefined();
    expect(result.results.reviews).toBeDefined();
    expect(result.results.users).toBeDefined();
  });

  it('should only search companies when type is "companies"', async () => {
    prisma.company.findMany.mockResolvedValue([]);

    const result = await service.search('test', 'companies', 10);

    expect(result.results.companies).toBeDefined();
    expect(result.results.reviews).toBeUndefined();
    expect(result.results.users).toBeUndefined();
  });

  it('should only search reviews when type is "reviews"', async () => {
    prisma.review.findMany.mockResolvedValue([]);

    const result = await service.search('test', 'reviews', 10);

    expect(result.results.reviews).toBeDefined();
    expect(result.results.companies).toBeUndefined();
  });

  it('should only search users when type is "users"', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    const result = await service.search('test', 'users', 10);

    expect(result.results.users).toBeDefined();
    expect(result.results.companies).toBeUndefined();
  });

  it('should respect limit parameter', async () => {
    prisma.company.findMany.mockResolvedValue([]);

    await service.search('test', 'companies', 5);

    const findCall = prisma.company.findMany.mock.calls[0][0];
    expect(findCall.take).toBe(5);
  });
});
