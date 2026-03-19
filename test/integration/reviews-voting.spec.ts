import { PrismaClient } from '@prisma/client';
import { getTestPrisma, truncateAll } from '../helpers/test-db.utils';
import {
  createTestUser,
  createTestReview,
  resetFactoryCounter,
} from '../helpers/factories';

describe('Reviews Voting (Integration)', () => {
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

  async function voteAndRecount(
    userId: string,
    reviewId: string,
    voteType: 'UP' | 'DOWN',
  ) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.helpfulVote.findUnique({
        where: { userId_reviewId: { userId, reviewId } },
      });

      if (existing) {
        if (existing.voteType === voteType) {
          await tx.helpfulVote.delete({
            where: { userId_reviewId: { userId, reviewId } },
          });
        } else {
          await tx.helpfulVote.update({
            where: { userId_reviewId: { userId, reviewId } },
            data: { voteType },
          });
        }
      } else {
        await tx.helpfulVote.create({
          data: { userId, reviewId, voteType },
        });
      }

      const helpfulCount = await tx.helpfulVote.count({
        where: { reviewId, voteType: 'UP' },
      });
      const downVoteCount = await tx.helpfulVote.count({
        where: { reviewId, voteType: 'DOWN' },
      });

      return tx.review.update({
        where: { id: reviewId },
        data: { helpfulCount, downVoteCount },
      });
    });
  }

  it('should set helpfulCount to 1 after UP vote', async () => {
    const author = await createTestUser(prisma);
    const voter = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);

    const updated = await voteAndRecount(voter.id, review.id, 'UP');

    expect(updated.helpfulCount).toBe(1);
    expect(updated.downVoteCount).toBe(0);
  });

  it('should toggle off when voting same type twice', async () => {
    const author = await createTestUser(prisma);
    const voter = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);

    await voteAndRecount(voter.id, review.id, 'UP');
    const updated = await voteAndRecount(voter.id, review.id, 'UP');

    expect(updated.helpfulCount).toBe(0);
    expect(updated.downVoteCount).toBe(0);
  });

  it('should switch from UP to DOWN', async () => {
    const author = await createTestUser(prisma);
    const voter = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);

    await voteAndRecount(voter.id, review.id, 'UP');
    const updated = await voteAndRecount(voter.id, review.id, 'DOWN');

    expect(updated.helpfulCount).toBe(0);
    expect(updated.downVoteCount).toBe(1);
  });

  it('should handle concurrent votes from different users accurately', async () => {
    const author = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);

    const voters = await Promise.all(
      Array.from({ length: 5 }, () => createTestUser(prisma)),
    );

    // Vote all UP concurrently
    await Promise.all(
      voters.map((v) => voteAndRecount(v.id, review.id, 'UP')),
    );

    // All 5 votes should exist in DB
    const voteCount = await prisma.helpfulVote.count({
      where: { reviewId: review.id, voteType: 'UP' },
    });
    expect(voteCount).toBe(5);

    // Do a final recount to verify consistency
    const final = await voteAndRecount(voters[0].id, review.id, 'UP');
    // voters[0] toggled off, so 4 UP votes remain
    expect(final.helpfulCount).toBe(4);
  });

  it('should enforce unique constraint on (userId, reviewId)', async () => {
    const author = await createTestUser(prisma);
    const voter = await createTestUser(prisma);
    const review = await createTestReview(prisma, author.id);

    await prisma.helpfulVote.create({
      data: { userId: voter.id, reviewId: review.id, voteType: 'UP' },
    });

    await expect(
      prisma.helpfulVote.create({
        data: { userId: voter.id, reviewId: review.id, voteType: 'DOWN' },
      }),
    ).rejects.toThrow();
  });
});
