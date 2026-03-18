import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '../config/config.service';

describe('AuthService — passwordHash exclusion', () => {
  let service: AuthService;
  let prisma: {
    user: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    const config = { jwtSecret: 'test-secret' } as ConfigService;
    service = new AuthService(prisma as unknown as PrismaService, config);
  });

  it('findUserByEmailOrUsername should use select without passwordHash', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: '1',
      email: 'a@b.com',
      username: 'alice',
    });

    const result = await service.findUserByEmailOrUsername('a@b.com', 'alice');

    expect(result).not.toHaveProperty('passwordHash');
    const call = prisma.user.findFirst.mock.calls[0][0];
    expect(call.select).toBeDefined();
    expect(call.select.passwordHash).toBeUndefined();
  });

  it('isUsernameAvailable should use select without passwordHash', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await service.isUsernameAvailable('alice');

    const call = prisma.user.findFirst.mock.calls[0][0];
    expect(call.select).toBeDefined();
    expect(call.select.passwordHash).toBeUndefined();
  });

  it('findUserByEmail should include passwordHash (needed for login)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: '1',
      email: 'a@b.com',
      username: 'alice',
      passwordHash: 'hashed',
    });

    const result = await service.findUserByEmail('a@b.com');

    expect(result).toHaveProperty('passwordHash');
    const call = prisma.user.findUnique.mock.calls[0][0];
    expect(call.select.passwordHash).toBe(true);
  });

  it('getUserById should include passwordHash (needed for change-password)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: '1',
      passwordHash: 'hashed',
    });

    const result = await service.getUserById('1');

    expect(result).toHaveProperty('passwordHash');
    const call = prisma.user.findUnique.mock.calls[0][0];
    expect(call.select.passwordHash).toBe(true);
  });
});

describe('AuthService — deleteOtherSessions', () => {
  let service: AuthService;
  let prisma: {
    user: { findFirst: jest.Mock; findUnique: jest.Mock };
    session: { deleteMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn(), findUnique: jest.fn() },
      session: { deleteMany: jest.fn() },
    };
    const config = { jwtSecret: 'test-secret' } as ConfigService;
    service = new AuthService(prisma as unknown as PrismaService, config);
  });

  it('should delete all sessions for user except the given token', async () => {
    prisma.session.deleteMany.mockResolvedValue({ count: 3 });

    const count = await service.deleteOtherSessions(
      'user-1',
      'keep-this-token',
    );

    expect(count).toBe(3);
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: { not: 'keep-this-token' } },
    });
  });

  it('should return 0 when no other sessions exist', async () => {
    prisma.session.deleteMany.mockResolvedValue({ count: 0 });

    const count = await service.deleteOtherSessions('user-1', 'only-token');

    expect(count).toBe(0);
  });
});
