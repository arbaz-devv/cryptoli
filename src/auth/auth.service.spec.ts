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

describe('AuthService — createUser', () => {
  let service: AuthService;
  let prisma: {
    user: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };
    const config = { jwtSecret: 'test-secret' } as ConfigService;
    service = new AuthService(prisma as unknown as PrismaService, config);
  });

  it('should create user and return profile without passwordHash', async () => {
    const returned = {
      id: '1',
      email: 'a@b.com',
      username: 'alice',
      role: 'USER',
      avatar: null,
      verified: false,
      reputation: 0,
    };
    prisma.user.create.mockResolvedValue(returned);

    const result = await service.createUser({
      email: 'a@b.com',
      username: 'alice',
      passwordHash: 'hashed',
    });

    expect(result).not.toHaveProperty('passwordHash');
    expect(result.email).toBe('a@b.com');
    const createCall = prisma.user.create.mock.calls[0][0];
    expect(createCall.data.passwordHash).toBe('hashed');
    expect(createCall.select.passwordHash).toBeUndefined();
  });
});

describe('AuthService — hashPassword / comparePassword', () => {
  let service: AuthService;

  beforeEach(() => {
    const prisma = {
      user: { findFirst: jest.fn(), findUnique: jest.fn() },
    };
    const config = { jwtSecret: 'test-secret' } as ConfigService;
    service = new AuthService(prisma as unknown as PrismaService, config);
  });

  it('should hash and verify password round-trip', async () => {
    const hash = await service.hashPassword('mypassword');
    expect(hash).not.toBe('mypassword');
    expect(hash.length).toBeGreaterThan(20);

    const match = await service.comparePassword('mypassword', hash);
    expect(match).toBe(true);
  });

  it('should reject wrong password', async () => {
    const hash = await service.hashPassword('correct');
    const match = await service.comparePassword('wrong', hash);
    expect(match).toBe(false);
  });
});

describe('AuthService — getSessionFromToken edge cases', () => {
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

  it('should return null for undefined token', async () => {
    const result = await service.getSessionFromToken(undefined);
    expect(result).toBeNull();
  });

  it('should return null for invalid JWT', async () => {
    const result = await service.getSessionFromToken('not-a-jwt');
    expect(result).toBeNull();
  });

  it('should return null for expired session in DB', async () => {
    prisma.session.create.mockResolvedValue({});
    const token = await service.createSession('user-1');

    prisma.session.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() - 1000), // expired
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

    const result = await service.getSessionFromToken(token);
    expect(result).toBeNull();
  });

  it('should return null when DB session is missing', async () => {
    prisma.session.create.mockResolvedValue({});
    const token = await service.createSession('user-1');

    prisma.session.findUnique.mockResolvedValue(null);

    const result = await service.getSessionFromToken(token);
    expect(result).toBeNull();
  });

  it('should return SessionUser when session is valid', async () => {
    prisma.session.create.mockResolvedValue({});
    const token = await service.createSession('user-1');

    prisma.session.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 86400000),
      user: {
        id: 'user-1',
        email: 'a@b.com',
        username: 'alice',
        role: 'USER',
        avatar: null,
        bio: 'hello',
        verified: true,
        reputation: 42,
      },
    });

    const result = await service.getSessionFromToken(token);
    expect(result).toEqual({
      id: 'user-1',
      email: 'a@b.com',
      username: 'alice',
      role: 'USER',
      avatar: null,
      bio: 'hello',
      verified: true,
      reputation: 42,
    });
  });
});

describe('AuthService — getSessionTokenFromRequest', () => {
  let service: AuthService;

  beforeEach(() => {
    const prisma = {
      user: { findFirst: jest.fn(), findUnique: jest.fn() },
    };
    const config = { jwtSecret: 'test-secret' } as ConfigService;
    service = new AuthService(prisma as unknown as PrismaService, config);
  });

  it('should prefer Bearer header over cookie', () => {
    const req = {
      headers: {
        authorization: 'Bearer header-token',
        cookie: 'session=cookie-token',
      },
      cookies: { session: 'cookie-token' },
    } as any;

    expect(service.getSessionTokenFromRequest(req)).toBe('header-token');
  });

  it('should fall back to parsed cookies from cookie-parser', () => {
    const req = {
      headers: {},
      cookies: { session: 'cookie-token' },
    } as any;

    expect(service.getSessionTokenFromRequest(req)).toBe('cookie-token');
  });

  it('should fall back to raw Cookie header when cookies not parsed', () => {
    const req = {
      headers: { cookie: 'session=raw-token; other=value' },
      cookies: {},
    } as any;

    expect(service.getSessionTokenFromRequest(req)).toBe('raw-token');
  });

  it('should return undefined when no auth present', () => {
    const req = {
      headers: {},
      cookies: {},
    } as any;

    expect(service.getSessionTokenFromRequest(req)).toBeUndefined();
  });

  it('should ignore non-Bearer authorization schemes', () => {
    const req = {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
      cookies: {},
    } as any;

    expect(service.getSessionTokenFromRequest(req)).toBeUndefined();
  });
});

describe('AuthService — updateProfile', () => {
  let service: AuthService;
  let prisma: {
    user: { findFirst: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    const config = { jwtSecret: 'test-secret' } as ConfigService;
    service = new AuthService(prisma as unknown as PrismaService, config);
  });

  it('should trim bio and convert empty to null', async () => {
    prisma.user.update.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      username: 'alice',
      role: 'USER',
      avatar: null,
      bio: null,
      verified: false,
      reputation: 0,
    });

    await service.updateProfile('u1', { bio: '   ' });

    const updateCall = prisma.user.update.mock.calls[0][0];
    expect(updateCall.data.bio).toBeNull();
  });

  it('should trim username', async () => {
    prisma.user.update.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      username: 'alice',
      role: 'USER',
      avatar: null,
      bio: null,
      verified: false,
      reputation: 0,
    });

    await service.updateProfile('u1', { username: '  alice  ' });

    const updateCall = prisma.user.update.mock.calls[0][0];
    expect(updateCall.data.username).toBe('alice');
  });
});

describe('AuthService — generateUsernameSuggestions', () => {
  let service: AuthService;
  let prisma: {
    user: { findFirst: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const config = { jwtSecret: 'test-secret' } as ConfigService;
    service = new AuthService(prisma as unknown as PrismaService, config);
  });

  it('should return available candidates', async () => {
    const result = await service.generateUsernameSuggestions('alice');
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(8);
    // None should be the original input
    expect(result).not.toContain('alice');
  });

  it('should return empty for too-short base', async () => {
    const result = await service.generateUsernameSuggestions('ab');
    expect(result).toEqual([]);
  });

  it('should return empty for invalid characters', async () => {
    const result = await service.generateUsernameSuggestions('alice!@#');
    expect(result).toEqual([]);
  });

  it('should filter out taken usernames', async () => {
    prisma.user.findMany.mockResolvedValue([
      { username: 'alice_' },
      { username: 'alice26' },
    ]);

    const result = await service.generateUsernameSuggestions('alice');
    expect(result).not.toContain('alice_');
    expect(result).not.toContain('alice26');
  });
});
