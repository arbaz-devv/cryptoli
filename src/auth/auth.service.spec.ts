import { createHash } from 'node:crypto';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '../config/config.service';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

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

describe('AuthService — session token hashing', () => {
  let service: AuthService;
  let prisma: {
    user: { findFirst: jest.Mock; findUnique: jest.Mock };
    session: {
      create: jest.Mock;
      findUnique: jest.Mock;
      deleteMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn(), findUnique: jest.fn() },
      session: {
        create: jest.fn(),
        findUnique: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    const config = { jwtSecret: 'test-secret-key-for-jwt' } as ConfigService;
    service = new AuthService(prisma as unknown as PrismaService, config);
  });

  it('createSession should store a SHA-256 hash, not the raw JWT', async () => {
    prisma.session.create.mockResolvedValue({});

    const token = await service.createSession('user-1');

    // Token returned to caller is a JWT (contains dots)
    expect(token).toContain('.');

    // Token stored in DB is a 64-char hex string (SHA-256)
    const createCall = prisma.session.create.mock.calls[0][0];
    const storedToken = createCall.data.token as string;
    expect(storedToken).toMatch(/^[a-f0-9]{64}$/);
    expect(storedToken).toBe(sha256(token));
  });

  it('getSessionFromToken should look up by hashed token', async () => {
    // Use createSession to get a real JWT, then test lookup
    prisma.session.create.mockResolvedValue({});
    const jwt = await service.createSession('user-1');

    prisma.session.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 86400000),
      user: {
        id: 'user-1',
        email: 'a@b.com',
        username: 'alice',
        role: 'USER',
        avatar: null,
        bio: null,
        verified: false,
        reputation: 0,
      },
    });

    await service.getSessionFromToken(jwt);

    const findCall = prisma.session.findUnique.mock.calls[0][0];
    expect(findCall.where.token).toBe(sha256(jwt));
  });

  it('deleteSession should delete by hashed token', async () => {
    prisma.session.deleteMany.mockResolvedValue({ count: 1 });
    prisma.session.create.mockResolvedValue({});

    const jwt = await service.createSession('user-1');
    await service.deleteSession(jwt);

    const deleteCall = prisma.session.deleteMany.mock.calls[0][0];
    expect(deleteCall.where.token).toBe(sha256(jwt));
  });

  it('deleteOtherSessions should use hashed exceptToken', async () => {
    prisma.session.deleteMany.mockResolvedValue({ count: 3 });
    prisma.session.create.mockResolvedValue({});

    const jwt = await service.createSession('user-1');
    await service.deleteOtherSessions('user-1', jwt);

    const deleteCall = prisma.session.deleteMany.mock.calls[0][0];
    expect(deleteCall.where.token).toEqual({ not: sha256(jwt) });
  });
});

describe('AuthService — deleteOtherSessions', () => {
  let service: AuthService;
  let prisma: {
    user: { findFirst: jest.Mock; findUnique: jest.Mock };
    session: { deleteMany: jest.Mock; create: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn(), findUnique: jest.fn() },
      session: { deleteMany: jest.fn(), create: jest.fn() },
    };
    const config = { jwtSecret: 'test-secret' } as ConfigService;
    service = new AuthService(prisma as unknown as PrismaService, config);
  });

  it('should delete all sessions for user except the given token (hashed)', async () => {
    prisma.session.deleteMany.mockResolvedValue({ count: 3 });

    const count = await service.deleteOtherSessions(
      'user-1',
      'keep-this-token',
    );

    expect(count).toBe(3);
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: { not: sha256('keep-this-token') } },
    });
  });

  it('should return 0 when no other sessions exist', async () => {
    prisma.session.deleteMany.mockResolvedValue({ count: 0 });

    const count = await service.deleteOtherSessions('user-1', 'only-token');

    expect(count).toBe(0);
  });
});
