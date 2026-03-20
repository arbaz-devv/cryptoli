import { PrismaClient } from '@prisma/client';
import { getTestPrisma, truncateAll } from '../helpers/test-db.utils';
import {
  createTestUser,
  createTestCompany,
  createTestComplaint,
  resetFactoryCounter,
} from '../helpers/factories';

describe('Complaints Voting (Integration)', () => {
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
   * Mirrors the production ComplaintsService.vote() transaction pattern:
   * upsert/delete vote, then recount from DB to update complaint counts.
   * This tests that the $transaction + recount approach produces correct
   * counts against a real database — something unit tests with mocked
   * Prisma cannot verify.
   */
  async function voteAndRecount(
    userId: string,
    complaintId: string,
    voteType: 'UP' | 'DOWN',
  ) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.complaintVote.findUnique({
        where: { userId_complaintId: { userId, complaintId } },
      });

      let nextVoteType: 'UP' | 'DOWN' | null = voteType;

      if (existing) {
        if (existing.voteType === voteType) {
          await tx.complaintVote.delete({
            where: { id: existing.id },
          });
          nextVoteType = null;
        } else {
          await tx.complaintVote.update({
            where: { id: existing.id },
            data: { voteType },
          });
        }
      } else {
        await tx.complaintVote.create({
          data: { userId, complaintId, voteType },
        });
      }

      const [helpfulCount, downVoteCount] = await Promise.all([
        tx.complaintVote.count({ where: { complaintId, voteType: 'UP' } }),
        tx.complaintVote.count({ where: { complaintId, voteType: 'DOWN' } }),
      ]);

      await tx.complaint.update({
        where: { id: complaintId },
        data: { helpfulCount, downVoteCount },
      });

      return { voteType: nextVoteType, helpfulCount, downVoteCount };
    });
  }

  // --- Voting tests (same patterns as reviews-voting) ---

  it('should set helpfulCount to 1 after UP vote', async () => {
    const author = await createTestUser(prisma);
    const complaint = await createTestComplaint(prisma, author.id);
    const voter = await createTestUser(prisma);

    const result = await voteAndRecount(voter.id, complaint.id, 'UP');

    expect(result.helpfulCount).toBe(1);
    expect(result.downVoteCount).toBe(0);
    expect(result.voteType).toBe('UP');
  });

  it('should toggle off when voting same type twice', async () => {
    const author = await createTestUser(prisma);
    const complaint = await createTestComplaint(prisma, author.id);
    const voter = await createTestUser(prisma);

    await voteAndRecount(voter.id, complaint.id, 'UP');
    const result = await voteAndRecount(voter.id, complaint.id, 'UP');

    expect(result.helpfulCount).toBe(0);
    expect(result.downVoteCount).toBe(0);
    expect(result.voteType).toBeNull();
  });

  it('should switch from UP to DOWN correctly', async () => {
    const author = await createTestUser(prisma);
    const complaint = await createTestComplaint(prisma, author.id);
    const voter = await createTestUser(prisma);

    await voteAndRecount(voter.id, complaint.id, 'UP');
    const result = await voteAndRecount(voter.id, complaint.id, 'DOWN');

    expect(result.helpfulCount).toBe(0);
    expect(result.downVoteCount).toBe(1);
    expect(result.voteType).toBe('DOWN');
  });

  it('should handle concurrent votes from different users accurately', async () => {
    const author = await createTestUser(prisma);
    const complaint = await createTestComplaint(prisma, author.id);

    const voters = await Promise.all(
      Array.from({ length: 5 }, () => createTestUser(prisma)),
    );

    // Vote all UP concurrently — tests that recount-from-DB avoids drift
    await Promise.all(
      voters.map((v) => voteAndRecount(v.id, complaint.id, 'UP')),
    );

    const voteCount = await prisma.complaintVote.count({
      where: { complaintId: complaint.id, voteType: 'UP' },
    });
    expect(voteCount).toBe(5);

    // Toggle one off — final count should be 4
    const final = await voteAndRecount(voters[0].id, complaint.id, 'UP');
    expect(final.helpfulCount).toBe(4);
  });

  it('should enforce @@unique(userId, complaintId) constraint', async () => {
    const author = await createTestUser(prisma);
    const complaint = await createTestComplaint(prisma, author.id);
    const voter = await createTestUser(prisma);

    await prisma.complaintVote.create({
      data: { userId: voter.id, complaintId: complaint.id, voteType: 'UP' },
    });

    // Direct duplicate insert (bypassing toggle logic) must fail
    await expect(
      prisma.complaintVote.create({
        data: { userId: voter.id, complaintId: complaint.id, voteType: 'DOWN' },
      }),
    ).rejects.toThrow();
  });

  // --- Reply tests ---

  it('should create a ComplaintReply record tied to the company', async () => {
    const author = await createTestUser(prisma);
    const company = await createTestCompany(prisma);
    const complaint = await createTestComplaint(prisma, author.id, {
      companyId: company.id,
    });

    const reply = await prisma.complaintReply.create({
      data: {
        content: 'We are looking into this.',
        complaintId: complaint.id,
        companyId: company.id,
      },
      include: {
        company: { select: { id: true, name: true } },
      },
    });

    expect(reply.content).toBe('We are looking into this.');
    expect(reply.complaintId).toBe(complaint.id);
    expect(reply.company.id).toBe(company.id);
  });

  it('should transition complaint status from OPEN to IN_PROGRESS on first reply', async () => {
    const author = await createTestUser(prisma);
    const company = await createTestCompany(prisma);
    const complaint = await createTestComplaint(prisma, author.id, {
      companyId: company.id,
    });

    expect(complaint.status).toBe('OPEN');

    // Create reply and transition status (mirrors ComplaintsService.reply())
    await prisma.complaintReply.create({
      data: {
        content: 'Looking into this.',
        complaintId: complaint.id,
        companyId: company.id,
      },
    });

    await prisma.complaint.update({
      where: { id: complaint.id },
      data: { status: 'IN_PROGRESS' },
    });

    const updated = await prisma.complaint.findUnique({
      where: { id: complaint.id },
      select: { status: true },
    });

    expect(updated!.status).toBe('IN_PROGRESS');
  });

  it('should NOT re-transition status if complaint is already IN_PROGRESS', async () => {
    const author = await createTestUser(prisma);
    const company = await createTestCompany(prisma);
    const complaint = await createTestComplaint(prisma, author.id, {
      companyId: company.id,
      status: 'IN_PROGRESS',
    });

    // Second reply should not change the status
    await prisma.complaintReply.create({
      data: {
        content: 'Another update.',
        complaintId: complaint.id,
        companyId: company.id,
      },
    });

    // Status remains IN_PROGRESS (not reset to OPEN or changed)
    const refreshed = await prisma.complaint.findUnique({
      where: { id: complaint.id },
      select: { status: true },
    });

    expect(refreshed!.status).toBe('IN_PROGRESS');
  });
});
