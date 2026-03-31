import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AnalyticsService } from '../analytics/analytics.service';
import type { AnalyticsContext } from '../analytics/analytics-context';
import { ObservabilityService } from '../observability/observability.service';

const PROFILE_CACHE_PREFIX = 'profile:v2:';
const PROFILE_CACHE_TTL_SEC = 90;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly observability: ObservabilityService,
    @Optional() private readonly analyticsService?: AnalyticsService,
  ) {}

  async getPublicProfile(viewerId: string | null, username: string) {
    const redis = this.redisService.getClient();
    const cacheEnabled = this.redisService.isReady() && redis !== null;
    const cacheKey = `${PROFILE_CACHE_PREFIX}${username}`;
    let cached: { user: unknown; stats: unknown } | null = null;
    if (cacheEnabled) {
      try {
        const raw = await redis.get(cacheKey);
        if (raw) {
          this.observability.recordCacheHit('users.profile');
          cached = JSON.parse(raw) as { user: unknown; stats: unknown };
        } else {
          this.observability.recordCacheMiss('users.profile');
        }
      } catch {
        // ignore cache read errors
      }
    }

    type ProfileUser = {
      id: string;
      email: string;
      username: string;
      avatar: string | null;
      bio: string | null;
      verified: boolean;
      reputation: number;
      createdAt: Date;
    };
    type ProfileStats = {
      followersCount: number;
      followingCount: number;
      postsCount: number;
      complaintsCount: number;
    };
    let user: ProfileUser | null;
    let stats: ProfileStats;

    if (
      cached?.user &&
      cached?.stats &&
      typeof cached.stats === 'object' &&
      'followersCount' in cached.stats
    ) {
      user = cached.user as ProfileUser;
      stats = cached.stats as ProfileStats;
    } else {
      const userWithCounts = await this.prisma.user.findUnique({
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
          _count: {
            select: {
              followers: true,
              following: true,
              posts: true,
              complaints: true,
            },
          },
        },
      });
      if (!userWithCounts) {
        throw new NotFoundException('User not found');
      }
      const { _count, ...baseUser } = userWithCounts;
      user = baseUser;
      stats = {
        followersCount: _count.following,
        followingCount: _count.followers,
        postsCount: _count.posts,
        complaintsCount: _count.complaints,
      };
      if (cacheEnabled) {
        try {
          await redis.setex(
            cacheKey,
            PROFILE_CACHE_TTL_SEC,
            JSON.stringify({ user, stats }),
          );
        } catch {
          // ignore cache write errors
        }
      }
    }

    let isFollowing = false;
    if (viewerId && user) {
      const follow = await this.prisma.follow.findFirst({
        where: { followerId: viewerId, followingId: user.id },
        select: { id: true },
      });
      isFollowing = Boolean(follow);
    }

    return {
      user,
      stats,
      viewerState: { isFollowing },
    };
  }

  private async invalidateProfileCache(username: string): Promise<void> {
    const redis = this.redisService.getClient();
    if (!this.redisService.isReady() || !redis) return;
    try {
      await redis.del(`${PROFILE_CACHE_PREFIX}${username}`);
    } catch {
      // ignore
    }
  }

  async followUser(
    followerId: string,
    targetUsername: string,
    analyticsCtx?: AnalyticsContext,
  ) {
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
    await this.invalidateProfileCache(targetUsername);

    if (analyticsCtx && this.analyticsService) {
      void this.analyticsService.track(
        analyticsCtx.ip,
        analyticsCtx.userAgent,
        {
          event: 'user_follow',
          consent: true,
          userId: followerId,
          properties: {
            targetUserId: target.id,
            targetUsername,
          },
        },
        analyticsCtx.country,
      );
    }

    return { following: true };
  }

  async unfollowUser(
    followerId: string,
    targetUsername: string,
    analyticsCtx?: AnalyticsContext,
  ) {
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
    await this.invalidateProfileCache(targetUsername);

    if (analyticsCtx && this.analyticsService) {
      void this.analyticsService.track(
        analyticsCtx.ip,
        analyticsCtx.userAgent,
        {
          event: 'user_unfollow',
          consent: true,
          userId: followerId,
          properties: {
            targetUserId: target.id,
            targetUsername,
          },
        },
        analyticsCtx.country,
      );
    }

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

  async getFollowStatus(
    viewerId: string | null,
    username: string,
  ): Promise<{ following: boolean }> {
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
    const unique = [...new Set(list)]
      .filter((u) => u && typeof u === 'string')
      .slice(0, 50);
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
    const idByUsername = new Map(users.map((u) => [u.username, u.id]));
    const following: Record<string, boolean> = {};
    for (const u of unique) {
      const id = idByUsername.get(u);
      following[u] = id ? followingSet.has(id) : false;
    }
    return { following };
  }
}
