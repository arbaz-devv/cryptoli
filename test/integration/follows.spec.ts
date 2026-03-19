import { PrismaClient } from '@prisma/client';
import { getTestPrisma, truncateAll } from '../helpers/test-db.utils';
import {
  createTestUser,
  createTestCompany,
  resetFactoryCounter,
} from '../helpers/factories';

describe('Follows (Integration)', () => {
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

  describe('User follows', () => {
    it('should create and delete follow', async () => {
      const user1 = await createTestUser(prisma);
      const user2 = await createTestUser(prisma);

      await prisma.follow.create({
        data: { followerId: user1.id, followingId: user2.id },
      });

      let count = await prisma.follow.count({
        where: { followingId: user2.id },
      });
      expect(count).toBe(1);

      await prisma.follow.deleteMany({
        where: { followerId: user1.id, followingId: user2.id },
      });

      count = await prisma.follow.count({
        where: { followingId: user2.id },
      });
      expect(count).toBe(0);
    });

    it('should enforce unique constraint on (followerId, followingId)', async () => {
      const user1 = await createTestUser(prisma);
      const user2 = await createTestUser(prisma);

      await prisma.follow.create({
        data: { followerId: user1.id, followingId: user2.id },
      });

      await expect(
        prisma.follow.create({
          data: { followerId: user1.id, followingId: user2.id },
        }),
      ).rejects.toThrow();
    });

    it('should cascade-delete follows when user is deleted', async () => {
      const user1 = await createTestUser(prisma);
      const user2 = await createTestUser(prisma);

      await prisma.follow.create({
        data: { followerId: user1.id, followingId: user2.id },
      });

      await prisma.user.delete({ where: { id: user1.id } });

      const follows = await prisma.follow.findMany({
        where: { followerId: user1.id },
      });
      expect(follows).toHaveLength(0);
    });
  });

  describe('Company follows', () => {
    it('should create company follow and enforce unique', async () => {
      const user = await createTestUser(prisma);
      const company = await createTestCompany(prisma);

      await prisma.companyFollow.create({
        data: { userId: user.id, companyId: company.id },
      });

      const count = await prisma.companyFollow.count({
        where: { companyId: company.id },
      });
      expect(count).toBe(1);

      await expect(
        prisma.companyFollow.create({
          data: { userId: user.id, companyId: company.id },
        }),
      ).rejects.toThrow();
    });
  });
});
