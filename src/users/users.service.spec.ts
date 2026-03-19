import { NotFoundException, BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import { createRedisMock } from '../../test/helpers/redis.mock';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let redisMock: ReturnType<typeof createRedisMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    redisMock = createRedisMock(false);
    service = new UsersService(
      prisma as unknown as PrismaService,
      redisMock as any,
    );
  });

  describe('getPublicProfile()', () => {
    it('should return profile from DB when cache miss', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        username: 'testuser',
        avatar: null,
        bio: null,
        verified: false,
        reputation: 0,
        createdAt: new Date(),
      });
      prisma.$transaction.mockResolvedValue([5, 3, 2, 1]);
      prisma.follow.findFirst.mockResolvedValue(null);

      const result = await service.getPublicProfile(null, 'testuser');

      expect(result.user).toBeDefined();
      expect(result.stats.followersCount).toBe(5);
      expect(result.viewerState.isFollowing).toBe(false);
    });

    it('should use Redis cache when available', async () => {
      redisMock = createRedisMock(true);
      redisMock._clientMock.get.mockResolvedValue(
        JSON.stringify({
          user: { id: 'u1', username: 'cached' },
          stats: {
            followersCount: 10,
            followingCount: 5,
            postsCount: 3,
            complaintsCount: 1,
          },
        }),
      );
      service = new UsersService(
        prisma as unknown as PrismaService,
        redisMock as any,
      );
      prisma.follow.findFirst.mockResolvedValue(null);

      const result = await service.getPublicProfile(null, 'cached');

      expect(result.stats.followersCount).toBe(10);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('should fall back to DB when Redis errors', async () => {
      redisMock = createRedisMock(true);
      redisMock._clientMock.get.mockRejectedValue(new Error('Redis down'));
      service = new UsersService(
        prisma as unknown as PrismaService,
        redisMock as any,
      );

      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        username: 'testuser',
        email: 'a@b.com',
        avatar: null,
        bio: null,
        verified: false,
        reputation: 0,
        createdAt: new Date(),
      });
      prisma.$transaction.mockResolvedValue([0, 0, 0, 0]);
      prisma.follow.findFirst.mockResolvedValue(null);

      const result = await service.getPublicProfile(null, 'testuser');
      expect(result.user).toBeDefined();
    });

    it('should throw NotFoundException for missing user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getPublicProfile(null, 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should check viewer follow status when viewerId provided', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u2',
        username: 'target',
        email: 'a@b.com',
        avatar: null,
        bio: null,
        verified: false,
        reputation: 0,
        createdAt: new Date(),
      });
      prisma.$transaction.mockResolvedValue([0, 0, 0, 0]);
      prisma.follow.findFirst.mockResolvedValue({ id: 'f1' });

      const result = await service.getPublicProfile('viewer1', 'target');

      expect(result.viewerState.isFollowing).toBe(true);
    });
  });

  describe('followUser()', () => {
    it('should create follow and invalidate cache', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      prisma.follow.create.mockResolvedValue({});

      const result = await service.followUser('u1', 'targetuser');

      expect(result.following).toBe(true);
      expect(prisma.follow.create).toHaveBeenCalledWith({
        data: { followerId: 'u1', followingId: 'u2' },
      });
    });

    it('should reject self-follow', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });

      await expect(service.followUser('u1', 'myself')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should handle duplicate follow (unique constraint) gracefully', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      prisma.follow.create.mockRejectedValue(new Error('unique constraint'));

      const result = await service.followUser('u1', 'targetuser');
      expect(result.following).toBe(true);
    });

    it('should throw NotFoundException for missing user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.followUser('u1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('unfollowUser()', () => {
    it('should delete follow', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      prisma.follow.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.unfollowUser('u1', 'targetuser');

      expect(result.following).toBe(false);
    });

    it('should reject self-unfollow', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });

      await expect(service.unfollowUser('u1', 'myself')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getFollowStatusBulk()', () => {
    it('should deduplicate usernames and cap at 50', async () => {
      const usernames = Array.from({ length: 60 }, (_, i) => `user${i}`);
      usernames.push('user0'); // duplicate
      prisma.user.findMany.mockResolvedValue([]);
      prisma.follow.findMany.mockResolvedValue([]);

      const result = await service.getFollowStatusBulk('viewer1', usernames);

      expect(Object.keys(result.following).length).toBe(50);
    });

    it('should return all false when no viewerId', async () => {
      const result = await service.getFollowStatusBulk(null, [
        'user1',
        'user2',
      ]);

      expect(result.following.user1).toBe(false);
      expect(result.following.user2).toBe(false);
    });

    it('should exclude self from follow checks', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u2', username: 'user2' }]);
      prisma.follow.findMany.mockResolvedValue([{ followingId: 'u2' }]);

      const result = await service.getFollowStatusBulk('viewer1', ['user2']);

      expect(result.following.user2).toBe(true);
    });
  });
});
