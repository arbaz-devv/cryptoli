import { PrismaClient } from '@prisma/client';
import { getTestPrisma, truncateAll } from '../helpers/test-db.utils';
import {
  createTestUser,
  createTestReview,
  createTestComment,
  resetFactoryCounter,
} from '../helpers/factories';

describe('Comments Voting (Integration)', () => {
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

  /**
   * Mirrors CommentsService.vote() transaction: toggle/upsert/delete vote,
   * then recount from DB to update helpfulCount/downVoteCount on the comment.
   * Verifies that $transaction + recount produces correct counts against
   * a real database — the invariant that prevents count drift under concurrency.
   */
  async function voteAndRecount(
    userId: string,
    commentId: string,
    voteType: 'UP' | 'DOWN',
  ) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.commentVote.findUnique({
        where: { userId_commentId: { userId, commentId } },
      });

      let nextVoteType: 'UP' | 'DOWN' | null = voteType;

      if (existing) {
        if (existing.voteType === voteType) {
          await tx.commentVote.delete({ where: { id: existing.id } });
          nextVoteType = null;
        } else {
          await tx.commentVote.update({
            where: { id: existing.id },
            data: { voteType },
          });
        }
      } else {
        await tx.commentVote.create({
          data: { userId, commentId, voteType },
        });
      }

      const [helpfulCount, downVoteCount] = await Promise.all([
        tx.commentVote.count({ where: { commentId, voteType: 'UP' } }),
        tx.commentVote.count({ where: { commentId, voteType: 'DOWN' } }),
      ]);

      await tx.comment.update({
        where: { id: commentId },
        data: { helpfulCount, downVoteCount },
      });

      return { voteType: nextVoteType, helpfulCount, downVoteCount };
    });
  }

  // --- Vote transaction-recount tests ---

  it('should set helpfulCount to 1 after UP vote', async () => {
    const author = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);
    const comment = await createTestComment(prisma, author.id, review.id);
    const voter = await createTestUser(prisma);

    const result = await voteAndRecount(voter.id, comment.id, 'UP');

    expect(result.helpfulCount).toBe(1);
    expect(result.downVoteCount).toBe(0);
    expect(result.voteType).toBe('UP');
  });

  it('should toggle off when voting same type twice', async () => {
    const author = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);
    const comment = await createTestComment(prisma, author.id, review.id);
    const voter = await createTestUser(prisma);

    await voteAndRecount(voter.id, comment.id, 'UP');
    const result = await voteAndRecount(voter.id, comment.id, 'UP');

    expect(result.helpfulCount).toBe(0);
    expect(result.downVoteCount).toBe(0);
    expect(result.voteType).toBeNull();
  });

  it('should switch from UP to DOWN correctly', async () => {
    const author = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);
    const comment = await createTestComment(prisma, author.id, review.id);
    const voter = await createTestUser(prisma);

    await voteAndRecount(voter.id, comment.id, 'UP');
    const result = await voteAndRecount(voter.id, comment.id, 'DOWN');

    expect(result.helpfulCount).toBe(0);
    expect(result.downVoteCount).toBe(1);
    expect(result.voteType).toBe('DOWN');
  });

  it('should handle concurrent votes without count drift', async () => {
    const author = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);
    const comment = await createTestComment(prisma, author.id, review.id);

    const voters = await Promise.all(
      Array.from({ length: 5 }, () => createTestUser(prisma)),
    );

    await Promise.all(
      voters.map((v) => voteAndRecount(v.id, comment.id, 'UP')),
    );

    const voteCount = await prisma.commentVote.count({
      where: { commentId: comment.id, voteType: 'UP' },
    });
    expect(voteCount).toBe(5);

    // Toggle one off — recount must reflect 4
    const final = await voteAndRecount(voters[0].id, comment.id, 'UP');
    expect(final.helpfulCount).toBe(4);
  });

  // --- Unique constraint ---

  it('should enforce @@unique(userId, commentId) constraint', async () => {
    const author = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);
    const comment = await createTestComment(prisma, author.id, review.id);
    const voter = await createTestUser(prisma);

    await prisma.commentVote.create({
      data: { userId: voter.id, commentId: comment.id, voteType: 'UP' },
    });

    await expect(
      prisma.commentVote.create({
        data: { userId: voter.id, commentId: comment.id, voteType: 'DOWN' },
      }),
    ).rejects.toThrow();
  });

  // --- Threaded reply creation ---

  it('should create a threaded reply with parentId', async () => {
    const author = await createTestUser(prisma);
    const replier = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);
    const parent = await createTestComment(prisma, author.id, review.id);

    const reply = await prisma.comment.create({
      data: {
        content: 'This is a threaded reply',
        authorId: replier.id,
        reviewId: review.id,
        parentId: parent.id,
      },
      include: { parent: { select: { id: true } } },
    });

    expect(reply.parentId).toBe(parent.id);
    expect(reply.parent!.id).toBe(parent.id);
    expect(reply.reviewId).toBe(review.id);
  });

  // --- Comment on review updates comment count ---

  it('should reflect actual comment count via DB count query', async () => {
    const author = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);

    // Create 3 top-level comments
    await createTestComment(prisma, author.id, review.id);
    await createTestComment(prisma, author.id, review.id);
    const third = await createTestComment(prisma, author.id, review.id);

    // Create a reply (should NOT count as top-level)
    await prisma.comment.create({
      data: {
        content: 'Reply to third comment',
        authorId: author.id,
        reviewId: review.id,
        parentId: third.id,
      },
    });

    // Top-level count (parentId: null) mirrors what CommentsService.create() emits
    const topLevelCount = await prisma.comment.count({
      where: { reviewId: review.id, parentId: null },
    });

    expect(topLevelCount).toBe(3);

    // Total count includes replies
    const totalCount = await prisma.comment.count({
      where: { reviewId: review.id },
    });
    expect(totalCount).toBe(4);
  });
});
