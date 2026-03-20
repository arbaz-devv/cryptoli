import { PrismaClient } from '@prisma/client';
import { getTestPrisma, truncateAll } from '../helpers/test-db.utils';
import { createTestUser, resetFactoryCounter } from '../helpers/factories';
import * as crypto from 'crypto';

describe('Auth Sessions (Integration)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = getTestPrisma();
  });

  beforeEach(async () => {
    resetFactoryCounter();
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  it('should create a session and look it up by hashed token', async () => {
    const user = await createTestUser(prisma);
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashed = hashToken(rawToken);

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        token: hashed,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const found = await prisma.session.findUnique({
      where: { token: hashed },
    });

    expect(found).not.toBeNull();
    expect(found!.id).toBe(session.id);
    expect(found!.userId).toBe(user.id);
  });

  it('should return null after session deletion', async () => {
    const user = await createTestUser(prisma);
    const token = hashToken('session-to-delete');

    await prisma.session.create({
      data: {
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    await prisma.session.delete({ where: { token } });

    const found = await prisma.session.findUnique({ where: { token } });
    expect(found).toBeNull();
  });

  it('should delete other sessions while keeping the current one', async () => {
    const user = await createTestUser(prisma);
    const currentToken = hashToken('current');
    const otherToken1 = hashToken('other1');
    const otherToken2 = hashToken('other2');

    const current = await prisma.session.create({
      data: {
        userId: user.id,
        token: currentToken,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await prisma.session.create({
      data: {
        userId: user.id,
        token: otherToken1,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await prisma.session.create({
      data: {
        userId: user.id,
        token: otherToken2,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    await prisma.session.deleteMany({
      where: {
        userId: user.id,
        id: { not: current.id },
      },
    });

    const remaining = await prisma.session.findMany({
      where: { userId: user.id },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].token).toBe(currentToken);
  });

  it('should cascade-delete sessions when user is deleted', async () => {
    const user = await createTestUser(prisma);
    await prisma.session.create({
      data: {
        userId: user.id,
        token: hashToken('cascade-test'),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    await prisma.user.delete({ where: { id: user.id } });

    const sessions = await prisma.session.findMany({
      where: { userId: user.id },
    });
    expect(sessions).toHaveLength(0);
  });
});
