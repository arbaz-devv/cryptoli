import { PrismaService } from './prisma.service';
import { ObservabilityService } from '../observability/observability.service';

const mockObservability = {
  recordDbOperation: jest.fn(),
} as unknown as ObservabilityService;

describe('PrismaService', () => {
  it('should call $disconnect on module destroy', async () => {
    const service = new PrismaService(mockObservability);
    // Mock $disconnect to avoid real DB connection
    service.$disconnect = jest.fn().mockResolvedValue(undefined);

    await service.onModuleDestroy();

    expect(service.$disconnect).toHaveBeenCalled();
  });

  it('should expose PrismaClient methods', () => {
    const service = new PrismaService(mockObservability);
    expect(typeof service.$disconnect).toBe('function');
    expect(typeof service.$connect).toBe('function');
    // Clean up - mock disconnect to prevent open handle
    service.$disconnect = jest.fn().mockResolvedValue(undefined);
  });
});
