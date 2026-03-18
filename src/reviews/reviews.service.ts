import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SocketService } from '../socket/socket.service';
import { NotFoundError } from '../common/errors';
import { createReviewSchema, calculateOverallScore } from '../common/utils';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socketService: SocketService,
    private readonly notificationsService: NotificationsService,
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

    const reviews = await this.prisma.review.findMany({
      where,
      select: {
        id: true,
        title: true,
        content: true,
        overallScore: true,
        criteriaScores: true,
        verified: true,
        helpfulCount: true,
        downVoteCount: true,
        reportCount: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        authorId: true,
        companyId: true,
        productId: true,
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
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    let reviewsWithVotes = reviews;
    if (user) {
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

    const total = await this.prisma.review.count({ where });

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

  async create(body: unknown, authorId: string) {
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

  async vote(reviewId: string, voteType: string, userId: string) {
    if (!voteType || (voteType !== 'UP' && voteType !== 'DOWN')) {
      throw new BadRequestException('Invalid vote type. Must be UP or DOWN');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: {
          id: true,
          title: true,
          authorId: true,
        },
      });
      if (!review) throw new NotFoundError('Review not found');

      const actor = await tx.user.findUnique({
        where: { id: userId },
        select: { username: true },
      });

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

      const [helpfulCount, downVoteCount] = await Promise.all([
        tx.helpfulVote.count({ where: { reviewId, voteType: 'UP' } }),
        tx.helpfulVote.count({ where: { reviewId, voteType: 'DOWN' } }),
      ]);

      await tx.review.update({
        where: { id: reviewId },
        data: { helpfulCount, downVoteCount },
      });

      return {
        reviewAuthorId: review.authorId,
        reviewTitle: review.title,
        actorUsername: actor?.username ?? 'Someone',
        voteType: nextVoteType,
        helpfulCount,
        downVoteCount,
      };
    });

    this.socketService.emitReviewVoteUpdated(
      reviewId,
      result.helpfulCount,
      result.downVoteCount,
    );

    if (result.reviewAuthorId !== userId && result.voteType) {
      await this.notificationsService.createForUser({
        userId: result.reviewAuthorId,
        type: 'NEW_REACTION',
        title: 'Someone reacted to your rating',
        message: `${result.actorUsername} ${
          result.voteType === 'UP' ? 'liked' : 'disliked'
        } your rating "${result.reviewTitle}".`,
        link: '/',
      });
    }

    return result;
  }

  async helpful(reviewId: string, userId: string) {
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

      const [helpfulCount, downVoteCount] = await Promise.all([
        tx.helpfulVote.count({ where: { reviewId, voteType: 'UP' } }),
        tx.helpfulVote.count({ where: { reviewId, voteType: 'DOWN' } }),
      ]);

      await tx.review.update({
        where: { id: reviewId },
        data: { helpfulCount, downVoteCount },
      });

      return { helpful, helpfulCount, downVoteCount };
    });

    this.socketService.emitReviewVoteUpdated(
      reviewId,
      result.helpfulCount,
      result.downVoteCount,
    );

    return { helpful: result.helpful };
  }
}
