import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SocketService } from '../socket/socket.service';
import { NotFoundError } from '../common/errors';
import { createReviewSchema, calculateOverallScore } from '../common/utils';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import type { AnalyticsContext } from '../analytics/analytics-context';

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

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socketService: SocketService,
    private readonly notificationsService: NotificationsService,
    @Optional() private readonly analyticsService?: AnalyticsService,
  ) {}

  async list(
    page: number,
    limit: number,
    category: string | undefined,
    companyId: string | undefined,
    username: string | undefined,
    status: string,
    user: { id: string } | null,
  ) {
    const where: Record<string, unknown> = {
      ...(status && { status }),
      ...(category && { company: { category } }),
      ...(companyId && { companyId }),
      ...(username && { author: { username } }),
    };

    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        select: {
          id: true,
          title: true,
          content: true,
          overallScore: true,
          helpfulCount: true,
          downVoteCount: true,
          createdAt: true,
          author: {
            select: {
              username: true,
              avatar: true,
              verified: true,
            },
          },
          company: {
            select: {
              name: true,
            },
          },
          _count: {
            select: {
              helpfulVotes: true,
              comments: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count({ where }),
    ]);

    let reviewsWithVotes = reviews;
    if (user && reviews.length > 0) {
      const reviewIds = reviews.map((r) => r.id);
      const userVotes = await this.prisma.helpfulVote.findMany({
        where: { userId: user.id, reviewId: { in: reviewIds } },
        select: { reviewId: true, voteType: true },
      });
      const voteMap = new Map(userVotes.map((v) => [v.reviewId, v.voteType]));
      reviewsWithVotes = reviews.map((r) => ({
        ...r,
        userVote: voteMap.get(r.id) ?? null,
      }));
    } else {
      reviewsWithVotes = reviews.map((r) => ({ ...r, userVote: null }));
    }

    return {
      reviews: reviewsWithVotes,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async create(
    body: unknown,
    authorId: string,
    analyticsCtx?: AnalyticsContext,
  ) {
    const validated = createReviewSchema.parse(body);
    const overallScore =
      validated.overallScore ?? calculateOverallScore(validated.criteriaScores);

    const review = await this.prisma.review.create({
      data: {
        title: validated.title,
        content: validated.content,
        authorId,
        companyId: validated.companyId,
        productId: validated.productId,
        overallScore,
        criteriaScores: validated.criteriaScores ?? {},
        status: 'APPROVED',
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatar: true,
            verified: true,
            reputation: true,
          },
        },
        company: {
          select: {
            id: true,
            name: true,
            slug: true,
            logo: true,
            category: true,
          },
        },
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        _count: {
          select: {
            helpfulVotes: true,
            comments: true,
            reactions: true,
          },
        },
      },
    });

    this.socketService.emitReviewCreated(review);

    if (analyticsCtx && this.analyticsService) {
      void this.analyticsService.track(
        analyticsCtx.ip,
        analyticsCtx.userAgent,
        {
          event: 'review_created',
          consent: true,
          userId: authorId,
          properties: { reviewId: review.id, companyId: validated.companyId },
        },
        analyticsCtx.country,
      );
    }

    return review;
  }

  async getById(id: string) {
    const review = await this.prisma.review.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatar: true,
            verified: true,
            reputation: true,
          },
        },
        company: true,
        product: true,
        comments: {
          include: {
            author: {
              select: {
                id: true,
                username: true,
                avatar: true,
              },
            },
            _count: { select: { reactions: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: {
          select: {
            helpfulVotes: true,
            comments: true,
            reactions: true,
          },
        },
      },
    });

    if (!review) {
      throw new NotFoundError('Review not found');
    }

    return review;
  }

  async vote(
    reviewId: string,
    voteType: string,
    userId: string,
    analyticsCtx?: AnalyticsContext,
  ) {
    if (!voteType || (voteType !== 'UP' && voteType !== 'DOWN')) {
      throw new BadRequestException('Invalid vote type. Must be UP or DOWN');
    }

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });

    const runVoteTransaction = async () =>
      this.prisma.$transaction(
        async (tx) => {
          const review = await tx.review.findUnique({
            where: { id: reviewId },
            select: {
              id: true,
              title: true,
              authorId: true,
            },
          });
          if (!review) throw new NotFoundError('Review not found');

          const existingVote = await tx.helpfulVote.findUnique({
            where: { userId_reviewId: { userId, reviewId } },
          });

          let nextVoteType: 'UP' | 'DOWN' | null = voteType;

          if (existingVote) {
            if (existingVote.voteType === voteType) {
              await tx.helpfulVote.delete({
                where: { id: existingVote.id },
              });
              nextVoteType = null;
            } else {
              await tx.helpfulVote.update({
                where: { id: existingVote.id },
                data: { voteType },
              });
            }
          } else {
            await tx.helpfulVote.create({
              data: { userId, reviewId, voteType },
            });
          }

          const previousVoteType = existingVote
            ? (existingVote.voteType as 'UP' | 'DOWN')
            : null;
          const { helpfulDelta, downDelta } = buildVoteCounterDelta(
            previousVoteType,
            nextVoteType,
          );

          const updatedReview = await tx.review.update({
            where: { id: reviewId },
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
            reviewAuthorId: review.authorId,
            reviewTitle: review.title,
            actorUsername: actor?.username ?? 'Someone',
            voteType: nextVoteType,
            helpfulCount: updatedReview.helpfulCount ?? 0,
            downVoteCount: updatedReview.downVoteCount ?? 0,
          };
        },
        { maxWait: 5000, timeout: 10000 },
      );

    let result: Awaited<ReturnType<typeof runVoteTransaction>>;
    try {
      result = await runVoteTransaction();
    } catch (error) {
      const isRetryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2028';
      const isTransactionNotFound =
        error instanceof Error &&
        /Transaction not found/i.test(error.message);

      if (!isRetryable && !isTransactionNotFound) {
        throw error;
      }

      result = await runVoteTransaction();
    }

    this.socketService.emitReviewVoteUpdated(
      reviewId,
      result.helpfulCount,
      result.downVoteCount,
    );

    if (result.reviewAuthorId !== userId && result.voteType) {
      void this.notificationsService.createForUser({
        userId: result.reviewAuthorId,
        type: 'NEW_REACTION',
        title: 'Someone reacted to your rating',
        message: `${result.actorUsername} ${
          result.voteType === 'UP' ? 'liked' : 'disliked'
        } your rating "${result.reviewTitle}".`,
        link: '/',
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
          properties: { reviewId, voteType: result.voteType },
        },
        analyticsCtx.country,
      );
    }

    return result;
  }

  async helpful(
    reviewId: string,
    userId: string,
    analyticsCtx?: AnalyticsContext,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true },
      });
      if (!review) throw new NotFoundError('Review not found');

      const existing = await tx.helpfulVote.findUnique({
        where: { userId_reviewId: { userId, reviewId } },
      });

      let helpful: boolean;

      if (existing) {
        await tx.helpfulVote.delete({ where: { id: existing.id } });
        helpful = false;
      } else {
        await tx.helpfulVote.create({
          data: { userId, reviewId },
        });
        helpful = true;
      }

      const previousVoteType = existing
        ? ((existing.voteType as 'UP' | 'DOWN' | null) ?? 'UP')
        : null;
      const nextVoteType: 'UP' | 'DOWN' | null = helpful ? 'UP' : null;
      const { helpfulDelta, downDelta } = buildVoteCounterDelta(
        previousVoteType,
        nextVoteType,
      );

      const updatedReview = await tx.review.update({
        where: { id: reviewId },
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
        helpful,
        helpfulCount: updatedReview.helpfulCount ?? 0,
        downVoteCount: updatedReview.downVoteCount ?? 0,
      };
    });

    this.socketService.emitReviewVoteUpdated(
      reviewId,
      result.helpfulCount,
      result.downVoteCount,
    );

    if (analyticsCtx && this.analyticsService) {
      void this.analyticsService.track(
        analyticsCtx.ip,
        analyticsCtx.userAgent,
        {
          event: 'vote_cast',
          consent: true,
          userId,
          properties: { reviewId, helpful: result.helpful },
        },
        analyticsCtx.country,
      );
    }

    return { helpful: result.helpful };
  }
}
