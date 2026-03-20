import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('should call $disconnect on module destroy', async () => {
    const service = new PrismaService();
    // Mock $disconnect to avoid real DB connection
    service.$disconnect = jest.fn().mockResolvedValue(undefined);

    await service.onModuleDestroy();

    expect(service.$disconnect).toHaveBeenCalled();
  });

  it('should expose PrismaClient methods', () => {
    const service = new PrismaService();
    expect(typeof service.$disconnect).toBe('function');
    expect(typeof service.$connect).toBe('function');
    // Clean up - mock disconnect to prevent open handle
    service.$disconnect = jest.fn().mockResolvedValue(undefined);
  });
});
