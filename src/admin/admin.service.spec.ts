import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminService — passwordHash exclusion', () => {
  let service: AdminService;
  let prisma: {
    user: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
      },
    };
    service = new AdminService(prisma as unknown as PrismaService);
  });

  it('getUserDetail should use select without passwordHash', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: '1',
      email: 'a@b.com',
      username: 'alice',
      name: 'Alice',
      avatar: null,
      role: 'USER',
      verified: false,
      reputation: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { reviews: 0 },
    });

    const result = await service.getUserDetail('1', true);

    expect(result.user).not.toHaveProperty('passwordHash');
    const call = prisma.user.findUnique.mock.calls[0][0];
    expect(call.select).toBeDefined();
    expect(call.select.passwordHash).toBeUndefined();
  });

  it('getUserDetail should throw NotFoundException for missing user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.getUserDetail('nonexistent')).rejects.toThrow(
      NotFoundException,
    );
  });
});
