import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createReactionSchema } from '../common/utils';
import type { ReactionType } from '@prisma/client';

@Injectable()
export class ReactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async toggle(userId: string, body: unknown) {
    const data = createReactionSchema.parse(body);
    const { type, reviewId, postId, commentId, complaintId } = data;

    // Exactly one target must be provided
    const targets = [reviewId, postId, commentId, complaintId].filter(Boolean);
    if (targets.length !== 1) {
      throw new BadRequestException(
        'Exactly one of reviewId, postId, commentId, or complaintId is required',
      );
    }

    // Verify target exists
    await this.verifyTargetExists({ reviewId, postId, commentId, complaintId });

    // Build unique filter for this user + target + type
    const where = this.buildUniqueWhere(userId, type as ReactionType, {
      reviewId,
      postId,
      commentId,
      complaintId,
    });

    const existing = await this.prisma.reaction.findFirst({ where });

    if (existing) {
      // Toggle off — same type on same target removes it
      await this.prisma.reaction.delete({ where: { id: existing.id } });
      return { action: 'removed' as const, type };
    }

    // Create new reaction
    const reaction = await this.prisma.reaction.create({
      data: {
        type: type as ReactionType,
        userId,
        reviewId: reviewId ?? null,
        postId: postId ?? null,
        commentId: commentId ?? null,
        complaintId: complaintId ?? null,
      },
    });

    return { action: 'created' as const, reaction };
  }

  async remove(userId: string, reactionId: string) {
    const reaction = await this.prisma.reaction.findUnique({
      where: { id: reactionId },
    });

    if (!reaction) {
      throw new NotFoundError('Reaction not found');
    }

    if (reaction.userId !== userId) {
      throw new BadRequestException('You can only remove your own reactions');
    }

    await this.prisma.reaction.delete({ where: { id: reactionId } });
    return { removed: true };
  }

  private async verifyTargetExists(targets: {
    reviewId?: string;
    postId?: string;
    commentId?: string;
    complaintId?: string;
  }) {
    if (targets.reviewId) {
      const review = await this.prisma.review.findUnique({
        where: { id: targets.reviewId },
        select: { id: true },
      });
      if (!review) throw new NotFoundError('Review not found');
    } else if (targets.postId) {
      const post = await this.prisma.post.findUnique({
        where: { id: targets.postId },
        select: { id: true },
      });
      if (!post) throw new NotFoundError('Post not found');
    } else if (targets.commentId) {
      const comment = await this.prisma.comment.findUnique({
        where: { id: targets.commentId },
        select: { id: true },
      });
      if (!comment) throw new NotFoundError('Comment not found');
    } else if (targets.complaintId) {
      const complaint = await this.prisma.complaint.findUnique({
        where: { id: targets.complaintId },
        select: { id: true },
      });
      if (!complaint) throw new NotFoundError('Complaint not found');
    }
  }

  private buildUniqueWhere(
    userId: string,
    type: ReactionType,
    targets: {
      reviewId?: string;
      postId?: string;
      commentId?: string;
      complaintId?: string;
    },
  ) {
    return {
      userId,
      type,
      ...(targets.reviewId && { reviewId: targets.reviewId }),
      ...(targets.postId && { postId: targets.postId }),
      ...(targets.commentId && { commentId: targets.commentId }),
      ...(targets.complaintId && { complaintId: targets.complaintId }),
    };
  }
}
