import { Injectable } from '@nestjs/common';

@Injectable()
export class SocketService {
  private get io() {
    return globalThis.__socketIO ?? null;
  }

  emitReviewCreated(review: unknown): void {
    const io = this.io;
    if (!io) return;
    io.to('reviews').emit('review:created', review);
  }

  emitReviewUpdated(review: unknown): void {
    const io = this.io;
    if (!io) return;
    io.to('reviews').emit('review:updated', review);
  }

  emitReviewVoteUpdated(
    reviewId: string,
    helpfulCount: number,
    downVoteCount: number,
  ): void {
    const io = this.io;
    if (!io) return;
    io.to('reviews').emit('review:vote:updated', {
      reviewId,
      helpfulCount,
      downVoteCount,
    });
  }

  emitNotificationCreated(userId: string, payload: unknown): void {
    const io = this.io;
    if (!io) return;
    io.to(`user:${userId}`).emit('notification:created', payload);
  }

  emitNotificationRead(userId: string, payload: unknown): void {
    const io = this.io;
    if (!io) return;
    io.to(`user:${userId}`).emit('notification:read', payload);
  }

  emitNotificationsAllRead(userId: string, payload: unknown): void {
    const io = this.io;
    if (!io) return;
    io.to(`user:${userId}`).emit('notification:all-read', payload);
  }

  /** Emit when a comment is added to a review so clients can update comment count. */
  emitCommentCountUpdated(reviewId: string, commentCount: number): void {
    const io = this.io;
    if (!io) return;
    io.to('reviews').emit('review:comment:count', { reviewId, commentCount });
  }
}
