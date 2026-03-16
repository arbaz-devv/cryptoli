import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getPublicProfile(viewerId: string | null, username: string) {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        email: true,
        username: true,
        avatar: true,
        bio: true,
        verified: true,
        reputation: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [followersCount, followingCount, postsCount, complaintsCount, isFollowing] =
      await Promise.all([
        this.prisma.follow.count({ where: { followingId: user.id } }),
        this.prisma.follow.count({ where: { followerId: user.id } }),
        this.prisma.post.count({ where: { authorId: user.id } }),
        this.prisma.complaint.count({ where: { authorId: user.id } }),
        viewerId
          ? this.prisma.follow
              .findFirst({
                where: { followerId: viewerId, followingId: user.id },
                select: { id: true },
              })
              .then(Boolean)
          : Promise.resolve(false),
      ]);

    return {
      user,
      stats: {
        followersCount,
        followingCount,
        postsCount,
        complaintsCount,
      },
      viewerState: {
        isFollowing,
      },
    };
  }

  async followUser(followerId: string, targetUsername: string) {
    const target = await this.prisma.user.findUnique({
      where: { username: targetUsername },
      select: { id: true },
    });
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (target.id === followerId) {
      throw new BadRequestException('You cannot follow yourself');
    }

    try {
      await this.prisma.follow.create({
        data: {
          followerId,
          followingId: target.id,
        },
      });
    } catch {
      // unique constraint already-following: treat as success
    }

    return { following: true };
  }

  async unfollowUser(followerId: string, targetUsername: string) {
    const target = await this.prisma.user.findUnique({
      where: { username: targetUsername },
      select: { id: true },
    });
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (target.id === followerId) {
      throw new BadRequestException('You cannot unfollow yourself');
    }

    await this.prisma.follow.deleteMany({
      where: {
        followerId,
        followingId: target.id,
      },
    });

    return { following: false };
  }

  async listFollowers(username: string) {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const followers = await this.prisma.follow.findMany({
      where: { followingId: user.id },
      include: {
        follower: {
          select: {
            id: true,
            username: true,
            avatar: true,
            bio: true,
            verified: true,
            reputation: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      users: followers.map((item) => item.follower),
    };
  }

  async listFollowing(username: string) {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const following = await this.prisma.follow.findMany({
      where: { followerId: user.id },
      include: {
        following: {
          select: {
            id: true,
            username: true,
            avatar: true,
            bio: true,
            verified: true,
            reputation: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      users: following.map((item) => item.following),
    };
  }

  async getFollowStatus(viewerId: string | null, username: string): Promise<{ following: boolean }> {
    if (!viewerId) return { following: false };
    const target = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (!target || target.id === viewerId) return { following: false };
    const follow = await this.prisma.follow.findFirst({
      where: { followerId: viewerId, followingId: target.id },
      select: { id: true },
    });
    return { following: Boolean(follow) };
  }

  async getFollowStatusBulk(
    viewerId: string | null,
    usernames: string[],
  ): Promise<{ following: Record<string, boolean> }> {
    const list = Array.isArray(usernames) ? usernames : [];
    const unique = [...new Set(list)].filter((u) => u && typeof u === 'string').slice(0, 50);
    if (!viewerId || unique.length === 0) {
      return { following: Object.fromEntries(unique.map((u) => [u, false])) };
    }
    const users = await this.prisma.user.findMany({
      where: { username: { in: unique }, id: { not: viewerId } },
      select: { id: true, username: true },
    });
    const ids = users.map((u) => u.id);
    const follows = await this.prisma.follow.findMany({
      where: { followerId: viewerId, followingId: { in: ids } },
      select: { followingId: true },
    });
    const followingSet = new Set(follows.map((f) => f.followingId));
    const idToUsername = new Map(users.map((u) => [u.id, u.username]));
    const following: Record<string, boolean> = {};
    for (const u of unique) {
      const found = users.find((x) => x.username === u);
      following[u] = found ? followingSet.has(found.id) : false;
    }
    return { following };
  }
}

