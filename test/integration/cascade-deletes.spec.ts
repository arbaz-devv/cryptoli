import { PrismaClient } from '@prisma/client';
import { getTestPrisma, truncateAll } from '../helpers/test-db.utils';
import {
  createTestUser,
  createTestCompany,
  createTestReview,
  createTestComplaint,
  createTestComment,
  resetFactoryCounter,
} from '../helpers/factories';

describe('Cascade Deletes (Integration)', () => {
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

  it('should cascade User delete to sessions, reviews, comments, votes, follows, notifications', async () => {
    const user = await createTestUser(prisma);
    const other = await createTestUser(prisma);
    const review = await createTestReview(prisma, user.id);

    await prisma.session.create({
      data: {
        userId: user.id,
        token: 'session-hash-1',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await createTestComment(prisma, user.id, review.id);
    await prisma.follow.create({
      data: { followerId: user.id, followingId: other.id },
    });
    await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'NEW_REVIEW',
        title: 'Test',
        message: 'Test notification',
      },
    });
    await prisma.helpfulVote.create({
      data: { userId: user.id, reviewId: review.id, voteType: 'UP' },
    });

    await prisma.user.delete({ where: { id: user.id } });

    // All dependent records should be gone
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.review.count({ where: { authorId: user.id } })).toBe(0);
    expect(await prisma.comment.count({ where: { authorId: user.id } })).toBe(0);
    expect(await prisma.follow.count({ where: { followerId: user.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.helpfulVote.count({ where: { userId: user.id } })).toBe(0);
  });

  it('should cascade Company delete to products, reviews, company follows, complaints', async () => {
    const user = await createTestUser(prisma);
    const company = await createTestCompany(prisma);

    const product = await prisma.product.create({
      data: {
        name: 'Test Product',
        slug: 'test-product',
        companyId: company.id,
        category: 'EXCHANGES',
      },
    });

    await createTestReview(prisma, user.id, { companyId: company.id });
    await createTestComplaint(prisma, user.id, { companyId: company.id });
    await prisma.companyFollow.create({
      data: { userId: user.id, companyId: company.id },
    });

    await prisma.company.delete({ where: { id: company.id } });

    expect(await prisma.product.count({ where: { companyId: company.id } })).toBe(0);
    expect(await prisma.review.count({ where: { companyId: company.id } })).toBe(0);
    expect(await prisma.complaint.count({ where: { companyId: company.id } })).toBe(0);
    expect(await prisma.companyFollow.count({ where: { companyId: company.id } })).toBe(0);
  });

  it('should cascade Review delete to comments, helpful votes, reactions', async () => {
    const user = await createTestUser(prisma);
    const voter = await createTestUser(prisma);
    const review = await createTestReview(prisma, user.id);

    await createTestComment(prisma, voter.id, review.id);
    await prisma.helpfulVote.create({
      data: { userId: voter.id, reviewId: review.id, voteType: 'UP' },
    });
    await prisma.reaction.create({
      data: { userId: voter.id, reviewId: review.id, type: 'LIKE' },
    });

    await prisma.review.delete({ where: { id: review.id } });

    expect(await prisma.comment.count({ where: { reviewId: review.id } })).toBe(0);
    expect(await prisma.helpfulVote.count({ where: { reviewId: review.id } })).toBe(0);
    expect(await prisma.reaction.count({ where: { reviewId: review.id } })).toBe(0);
  });

  it('should cascade Comment delete to child comments and comment votes', async () => {
    const user = await createTestUser(prisma);
    const review = await createTestReview(prisma, user.id);
    const parent = await createTestComment(prisma, user.id, review.id);
    await createTestComment(prisma, user.id, review.id, {
      parentId: parent.id,
    });
    await prisma.commentVote.create({
      data: { userId: user.id, commentId: parent.id, voteType: 'UP' },
    });

    await prisma.comment.delete({ where: { id: parent.id } });

    expect(
      await prisma.comment.count({ where: { parentId: parent.id } }),
    ).toBe(0);
    expect(
      await prisma.commentVote.count({ where: { commentId: parent.id } }),
    ).toBe(0);
  });
});
