import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createCommentSchema } from '../common/utils';
import { NotificationsService } from '../notifications/notifications.service';
import { SocketService } from '../socket/socket.service';
import { AnalyticsService } from '../analytics/analytics.service';
import type { AnalyticsContext } from '../analytics/analytics-context';
import { RedisService } from '../redis/redis.service';

function buildVoteCounterDelta(
  previousVoteType: 'UP' | 'DOWN' | null,
  nextVoteType: 'UP' | 'DOWN' | null,
) {
  const helpfulDelta =
    (nextVoteType === 'UP' ? 1 : 0) - (previousVoteType === 'UP' ? 1 : 0);
  const downDelta =
    (nextVoteType === 'DOWN' ? 1 : 0) - (previousVoteType === 'DOWN' ? 1 : 0);

  return { helpfulDelta, downDelta };
}

const COMMENT_PAGE_LIMIT_DEFAULT = 20;
const COMMENT_REPLY_PAGE_LIMIT_DEFAULT = 10;
const COMMENT_PAGE_LIMIT_MAX = 50;
const COMMENT_COUNT_CACHE_TTL_SEC = 120;

type CommentTarget = {
  reviewId?: string;
  postId?: string;
  complaintId?: string;
};

type CursorTokenPayload = {
  createdAt: string;
  id: string;
};

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (!limit || Number.isNaN(limit)) return fallback;
  return Math.min(COMMENT_PAGE_LIMIT_MAX, Math.max(1, Math.floor(limit)));
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString('base64url');
}

function decodeCursor(cursor?: string): CursorTokenPayload | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as CursorTokenPayload;
    if (!parsed?.id || !parsed?.createdAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildCommentCountCacheKey(target: CommentTarget): string | null {
  if (target.reviewId) return `comments:count:review:${target.reviewId}`;
  if (target.postId) return `comments:count:post:${target.postId}`;
  if (target.complaintId)
    return `comments:count:complaint:${target.complaintId}`;
  return null;
}

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly socketService: SocketService,
    private readonly redisService: RedisService,
    @Optional() private readonly analyticsService?: AnalyticsService,
  ) {}

  private buildTargetWhere(target: CommentTarget): Record<string, string> {
    const provided = [
      target.reviewId,
      target.postId,
      target.complaintId,
    ].filter((value): value is string => Boolean(value));
    if (provided.length > 1) {
      throw new BadRequestException(
        'Provide exactly one of reviewId, postId, complaintId',
      );
    }

    if (target.reviewId) return { reviewId: target.reviewId };
    if (target.postId) return { postId: target.postId };
    if (target.complaintId) return { complaintId: target.complaintId };
    return {};
  }

  private getCursorWhere(cursor?: string): Record<string, unknown> | undefined {
    const decoded = decodeCursor(cursor);
    if (!decoded) return undefined;
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime())) return undefined;

    return {
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: decoded.id } },
      ],
    };
  }

  private async getCachedTopLevelCommentCount(
    target: CommentTarget,
  ): Promise<number> {
    const where = {
      ...this.buildTargetWhere(target),
      parentId: null,
    };
    const cacheKey = buildCommentCountCacheKey(target);
    const redis = this.redisService.getClient();
    const cacheEnabled =
      this.redisService.isReady() && redis !== null && cacheKey !== null;

    if (cacheEnabled) {
      try {
        const raw = await redis.get(cacheKey);
        if (raw && /^\d+$/.test(raw)) {
          return Number(raw);
        }
      } catch {
        // ignore cache read errors
      }
    }

    const count = await this.prisma.comment.count({ where });

    if (cacheEnabled) {
      try {
        await redis.setex(cacheKey, COMMENT_COUNT_CACHE_TTL_SEC, String(count));
      } catch {
        // ignore cache write errors
      }
    }

    return count;
  }

  private async incrementCachedTopLevelCommentCount(
    target: CommentTarget,
  ): Promise<number | null> {
    const cacheKey = buildCommentCountCacheKey(target);
    const redis = this.redisService.getClient();
    if (!cacheKey || !this.redisService.isReady() || !redis) return null;

    try {
      const raw = await redis.get(cacheKey);
      if (!raw || !/^\d+$/.test(raw)) {
        return null;
      }
      const next = await redis.incrby(cacheKey, 1);
      await redis.expire(cacheKey, COMMENT_COUNT_CACHE_TTL_SEC);
      return Number(next);
    } catch {
      return null;
    }
  }

  private async listCommentsPage(options: {
    target: CommentTarget;
    parentId: string | null;
    user?: { id: string } | null;
    limit?: number;
    cursor?: string;
  }) {
    const limit = normalizeLimit(
      options.limit,
      options.parentId === null
        ? COMMENT_PAGE_LIMIT_DEFAULT
        : COMMENT_REPLY_PAGE_LIMIT_DEFAULT,
    );

    const where = {
      ...this.buildTargetWhere(options.target),
      parentId: options.parentId,
      ...(this.getCursorWhere(options.cursor) ?? {}),
    };

    const comments = await this.prisma.comment.findMany({
      where,
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatar: true,
            verified: true,
          },
        },
        _count: {
          select: {
            reactions: true,
            votes: true,
            replies: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = comments.length > limit;
    const pageItems = hasMore ? comments.slice(0, limit) : comments;
    const lastItem = pageItems.at(-1);
    const nextCursor =
      hasMore && lastItem
        ? encodeCursor(lastItem.createdAt, lastItem.id)
        : null;

    let commentsWithVotes = pageItems;
    if (options.user && pageItems.length > 0) {
      const userVotes = await this.prisma.commentVote.findMany({
        where: {
          userId: options.user.id,
          commentId: { in: pageItems.map((item) => item.id) },
        },
        select: { commentId: true, voteType: true },
      });
      const voteMap = new Map(userVotes.map((v) => [v.commentId, v.voteType]));
      commentsWithVotes = pageItems.map((comment) => ({
        ...comment,
        userVote: voteMap.get(comment.id) ?? null,
        helpfulCount: comment.helpfulCount ?? 0,
        downVoteCount: comment.downVoteCount ?? 0,
      }));
    } else {
      commentsWithVotes = pageItems.map((comment) => ({
        ...comment,
        userVote: null,
        helpfulCount: comment.helpfulCount ?? 0,
        downVoteCount: comment.downVoteCount ?? 0,
      }));
    }

    return {
      comments: commentsWithVotes,
      pagination: {
        limit,
        hasMore,
        nextCursor,
      },
      totalCount:
        options.parentId === null
          ? await this.getCachedTopLevelCommentCount(options.target)
          : undefined,
    };
  }

  async create(
    body: unknown,
    authorId: string,
    analyticsCtx?: AnalyticsContext,
  ) {
    const validated = createCommentSchema.parse(body);
    const targets = [
      validated.reviewId,
      validated.postId,
      validated.complaintId,
    ].filter((value): value is string => Boolean(value));
    if (targets.length === 0) {
      throw new BadRequestException(
        'Must provide reviewId, postId, or complaintId',
      );
    }
    if (targets.length > 1) {
      throw new BadRequestException(
        'Provide exactly one of reviewId, postId, or complaintId',
      );
    }

    const comment = await this.prisma.comment.create({
      data: {
        content: validated.content,
        authorId,
        reviewId: validated.reviewId,
        postId: validated.postId,
        complaintId: validated.complaintId,
        parentId: validated.parentId,
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatar: true,
            verified: true,
          },
        },
        _count: {
          select: {
            reactions: true,
            votes: true,
            replies: true,
          },
        },
      },
    });

    // Notify parent comment/reply author when someone replies (unless replying to self)
    if (validated.parentId && validated.reviewId) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: validated.parentId },
        select: { authorId: true },
      });
      if (parent && parent.authorId !== authorId) {
        const review = await this.prisma.review.findUnique({
          where: { id: validated.reviewId },
          select: { title: true },
        });
        const isReplyToReply = await this.prisma.comment
          .findUnique({
            where: { id: validated.parentId },
            select: { parentId: true },
          })
          .then((c) => !!c?.parentId);
        await this.notificationsService.createForUser({
          userId: parent.authorId,
          type: 'NEW_COMMENT',
          title: 'New reply to your comment',
          message: isReplyToReply
            ? `${comment.author.username} replied to your reply.`
            : `${comment.author.username} replied to your comment on "${review?.title ?? 'a review'}".`,
          link: `/?review=${validated.reviewId}`,
        });
      }
    }

    if (validated.reviewId) {
      const review = await this.prisma.review.findUnique({
        where: { id: validated.reviewId },
        select: {
          id: true,
          title: true,
          authorId: true,
          author: {
            select: {
              username: true,
            },
          },
        },
      });

      if (review && review.authorId !== authorId) {
        await this.notificationsService.createForUser({
          userId: review.authorId,
          type: 'NEW_COMMENT',
          title: 'New comment on your rating',
          message: `${comment.author.username} commented on "${review.title}".`,
          link: '/',
        });
      }

      let commentCount = validated.parentId
        ? null
        : await this.incrementCachedTopLevelCommentCount({
            reviewId: validated.reviewId,
          });
      if (commentCount === null) {
        commentCount = await this.getCachedTopLevelCommentCount({
          reviewId: validated.reviewId,
        });
      }
      this.socketService.emitCommentCountUpdated(
        validated.reviewId,
        commentCount,
      );
    }

    if (analyticsCtx && this.analyticsService) {
      void this.analyticsService.track(
        analyticsCtx.ip,
        analyticsCtx.userAgent,
        {
          event: 'comment_created',
          consent: true,
          userId: authorId,
          properties: {
            commentId: comment.id,
            reviewId: validated.reviewId,
            postId: validated.postId,
            complaintId: validated.complaintId,
          },
        },
        analyticsCtx.country,
      );
    }

    return comment;
  }

  async list(
    reviewId?: string,
    postId?: string,
    complaintId?: string,
    user?: { id: string } | null,
    options?: {
      parentId?: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    return this.listCommentsPage({
      target: { reviewId, postId, complaintId },
      parentId: options?.parentId ?? null,
      user,
      limit: options?.limit,
      cursor: options?.cursor,
    });
  }

  async getById(
    id: string,
    reviewId?: string,
    postId?: string,
    complaintId?: string,
    user?: { id: string } | null,
  ) {
    if (id === 'list') {
      return this.list(reviewId, postId, complaintId, user);
    }

    const where: Record<string, unknown> = { parentId: null };
    if (reviewId) where.reviewId = reviewId;
    if (postId) where.postId = postId;
    if (complaintId) where.complaintId = complaintId;
    where.id = id;

    const comments = await this.prisma.comment.findMany({
      where,
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatar: true,
            verified: true,
          },
        },
        _count: {
          select: {
            reactions: true,
            votes: true,
            replies: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    let commentsWithVotes = comments;
    if (user && comments.length > 0) {
      const userVotes = await this.prisma.commentVote.findMany({
        where: {
          userId: user.id,
          commentId: { in: comments.map((c) => c.id) },
        },
        select: { commentId: true, voteType: true },
      });
      const voteMap = new Map(userVotes.map((v) => [v.commentId, v.voteType]));
      commentsWithVotes = comments.map((comment) => ({
        ...comment,
        userVote: voteMap.get(comment.id) ?? null,
        helpfulCount: comment.helpfulCount ?? 0,
        downVoteCount: comment.downVoteCount ?? 0,
      }));
    } else {
      commentsWithVotes = comments.map((comment) => ({
        ...comment,
        userVote: null,
        helpfulCount: comment.helpfulCount ?? 0,
        downVoteCount: comment.downVoteCount ?? 0,
      }));
    }

    const comment = commentsWithVotes[0] ?? null;
    if (!comment) return null;

    const replies = await this.prisma.comment.findMany({
      where: { parentId: comment.id },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatar: true,
            verified: true,
          },
        },
        _count: {
          select: {
            reactions: true,
            votes: true,
            replies: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return { ...comment, replies };
  }

  async vote(
    commentId: string,
    voteType: string,
    userId: string,
    analyticsCtx?: AnalyticsContext,
  ) {
    if (!voteType || (voteType !== 'UP' && voteType !== 'DOWN')) {
      throw new BadRequestException('Invalid vote type. Must be UP or DOWN');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const comment = await tx.comment.findUnique({
        where: { id: commentId },
        select: { id: true, authorId: true },
      });
      if (!comment) throw new NotFoundError('Comment not found');

      const existingVote = await tx.commentVote.findUnique({
        where: {
          userId_commentId: { userId, commentId },
        },
      });

      let nextVoteType: 'UP' | 'DOWN' | null = voteType;

      if (existingVote) {
        if (existingVote.voteType === voteType) {
          await tx.commentVote.delete({
            where: { id: existingVote.id },
          });
          nextVoteType = null;
        } else {
          await tx.commentVote.update({
            where: { id: existingVote.id },
            data: { voteType },
          });
        }
      } else {
        await tx.commentVote.create({
          data: {
            userId,
            commentId,
            voteType,
          },
        });
      }

      const previousVoteType = existingVote
        ? (existingVote.voteType as 'UP' | 'DOWN')
        : null;
      const { helpfulDelta, downDelta } = buildVoteCounterDelta(
        previousVoteType,
        nextVoteType,
      );

      const updatedComment = await tx.comment.update({
        where: { id: commentId },
        data: {
          ...(helpfulDelta !== 0
            ? { helpfulCount: { increment: helpfulDelta } }
            : {}),
          ...(downDelta !== 0
            ? { downVoteCount: { increment: downDelta } }
            : {}),
        },
        select: {
          helpfulCount: true,
          downVoteCount: true,
        },
      });

      return {
        voteType: nextVoteType,
        helpfulCount: updatedComment.helpfulCount ?? 0,
        downVoteCount: updatedComment.downVoteCount ?? 0,
        commentAuthorId: comment.authorId,
        voterId: userId,
        isNewUpVote: nextVoteType === 'UP',
      };
    });

    // Notify comment author when someone likes (UP votes) their comment (unless self)
    if (
      result.commentAuthorId &&
      result.voterId !== result.commentAuthorId &&
      result.isNewUpVote
    ) {
      const commentWithReview = await this.prisma.comment.findUnique({
        where: { id: commentId },
        select: { reviewId: true },
      });
      const voter = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { username: true },
      });
      await this.notificationsService.createForUser({
        userId: result.commentAuthorId,
        type: 'NEW_REACTION',
        title: 'Someone liked your comment',
        message: `${voter?.username ?? 'Someone'} found your comment helpful.`,
        link: commentWithReview?.reviewId
          ? `/?review=${commentWithReview.reviewId}`
          : '/',
      });
    }

    if (analyticsCtx && this.analyticsService) {
      void this.analyticsService.track(
        analyticsCtx.ip,
        analyticsCtx.userAgent,
        {
          event: 'vote_cast',
          consent: true,
          userId,
          properties: { commentId, voteType: result.voteType },
        },
        analyticsCtx.country,
      );
    }

    return {
      voteType: result.voteType,
      helpfulCount: result.helpfulCount,
      downVoteCount: result.downVoteCount,
    };
  }
}
