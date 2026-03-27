import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createComplaintSchema, createReplySchema } from '../common/utils';

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
export class ComplaintsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    page: number,
    limit: number,
    companyId?: string,
    userId?: string,
    username?: string,
    user?: { id: string } | null,
  ) {
    const where: Record<string, unknown> = {};
    if (companyId) where.companyId = companyId;
    if (userId) where.authorId = userId;
    if (username) {
      const u = await this.prisma.user.findUnique({
        where: { username },
        select: { id: true },
      });
      if (u) {
        where.authorId = u.id;
      } else {
        return {
          complaints: [],
          pagination: { page, limit, total: 0, totalPages: 0 },
        };
      }
    }

    const complaints = await this.prisma.complaint.findMany({
      where,
      select: {
        id: true,
        title: true,
        content: true,
        status: true,
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
        _count: {
          select: {
            comments: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    let complaintsWithVotes = complaints;
    if (user) {
      const complaintIds = complaints.map((c) => c.id);
      const userVotes = await this.prisma.complaintVote.findMany({
        where: { userId: user.id, complaintId: { in: complaintIds } },
        select: { complaintId: true, voteType: true },
      });
      const voteMap = new Map(
        userVotes.map((v) => [v.complaintId, v.voteType]),
      );
      complaintsWithVotes = complaints.map((c) => ({
        ...c,
        userVote: voteMap.get(c.id) ?? null,
      }));
    } else {
      complaintsWithVotes = complaints.map((c) => ({
        ...c,
        userVote: null,
      }));
    }

    const total = await this.prisma.complaint.count({ where });

    return {
      complaints: complaintsWithVotes,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async create(body: unknown, authorId: string) {
    const validated = createComplaintSchema.parse(body);
    const complaint = await this.prisma.complaint.create({
      data: {
        title: validated.title,
        content: validated.content,
        authorId,
        companyId: validated.companyId,
        productId: validated.productId,
        status: 'OPEN',
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
            comments: true,
            reactions: true,
            votes: true,
          },
        },
      },
    });
    return complaint;
  }

  async getById(id: string, user?: { id: string } | null) {
    const complaint = await this.prisma.complaint.findUnique({
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
        replies: {
          include: {
            company: {
              select: {
                id: true,
                name: true,
                logo: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        _count: {
          select: {
            comments: true,
            reactions: true,
            votes: true,
          },
        },
      },
    });

    if (!complaint) {
      throw new NotFoundError('Complaint not found');
    }

    let userVote: string | null = null;
    if (user) {
      const vote = await this.prisma.complaintVote.findUnique({
        where: {
          userId_complaintId: { userId: user.id, complaintId: id },
        },
        select: { voteType: true },
      });
      userVote = vote?.voteType ?? null;
    }

    return { ...complaint, userVote };
  }

  async vote(complaintId: string, voteType: string, userId: string) {
    if (!voteType || (voteType !== 'UP' && voteType !== 'DOWN')) {
      throw new BadRequestException('Invalid vote type. Must be UP or DOWN');
    }

    return this.prisma.$transaction(async (tx) => {
      const complaint = await tx.complaint.findUnique({
        where: { id: complaintId },
        select: { id: true },
      });
      if (!complaint) throw new NotFoundError('Complaint not found');

      const existingVote = await tx.complaintVote.findUnique({
        where: {
          userId_complaintId: { userId, complaintId },
        },
      });

      let nextVoteType: 'UP' | 'DOWN' | null = voteType;

      if (existingVote) {
        if (existingVote.voteType === voteType) {
          await tx.complaintVote.delete({
            where: { id: existingVote.id },
          });
          nextVoteType = null;
        } else {
          await tx.complaintVote.update({
            where: { id: existingVote.id },
            data: { voteType },
          });
        }
      } else {
        await tx.complaintVote.create({
          data: {
            userId,
            complaintId,
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

      const updatedComplaint = await tx.complaint.update({
        where: { id: complaintId },
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
        helpfulCount: updatedComplaint.helpfulCount ?? 0,
        downVoteCount: updatedComplaint.downVoteCount ?? 0,
      };
    });
  }

  async reply(complaintId: string, content: string) {
    const validated = createReplySchema.parse({ content });
    const complaint = await this.prisma.complaint.findUnique({
      where: { id: complaintId },
      include: { company: true },
    });

    if (!complaint) {
      throw new NotFoundError('Complaint not found');
    }

    if (!complaint.companyId) {
      throw new BadRequestException(
        'Complaint does not have an associated company',
      );
    }

    const company = await this.prisma.company.findUnique({
      where: { id: complaint.companyId },
    });

    if (!company) {
      throw new BadRequestException('Company not found');
    }

    const reply = await this.prisma.complaintReply.create({
      data: {
        content: validated.content,
        complaintId,
        companyId: complaint.companyId,
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            logo: true,
          },
        },
      },
    });

    if (complaint.status === 'OPEN') {
      await this.prisma.complaint.update({
        where: { id: complaintId },
        data: { status: 'IN_PROGRESS' },
      });
    }

    return reply;
  }
}
