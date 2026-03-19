import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createReportSchema } from '../common/utils';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(reporterId: string, body: unknown) {
    const data = createReportSchema.parse(body);
    const { reason, reviewId, commentId, complaintId } = data;

    const targets = [reviewId, commentId, complaintId].filter(Boolean);
    if (targets.length !== 1) {
      throw new BadRequestException(
        'Exactly one of reviewId, commentId, or complaintId is required',
      );
    }

    // Verify target exists
    if (reviewId) {
      const review = await this.prisma.review.findUnique({
        where: { id: reviewId },
        select: { id: true },
      });
      if (!review) throw new NotFoundError('Review not found');
    } else if (commentId) {
      const comment = await this.prisma.comment.findUnique({
        where: { id: commentId },
        select: { id: true },
      });
      if (!comment) throw new NotFoundError('Comment not found');
    } else if (complaintId) {
      const complaint = await this.prisma.complaint.findUnique({
        where: { id: complaintId },
        select: { id: true },
      });
      if (!complaint) throw new NotFoundError('Complaint not found');
    }

    // Create the report and update denormalized reportCount in a transaction
    // Report model has no Prisma relations — it's append-only
    const report = await this.prisma.$transaction(async (tx) => {
      const created = await tx.report.create({
        data: {
          reporterId,
          reason,
          reviewId: reviewId ?? null,
          commentId: commentId ?? null,
          complaintId: complaintId ?? null,
        },
      });

      // Update reportCount on Review or Complaint (Comment has no reportCount field)
      if (reviewId) {
        const count = await tx.report.count({ where: { reviewId } });
        await tx.review.update({
          where: { id: reviewId },
          data: { reportCount: count },
        });
      } else if (complaintId) {
        const count = await tx.report.count({ where: { complaintId } });
        await tx.complaint.update({
          where: { id: complaintId },
          data: { reportCount: count },
        });
      }
      // Comment reports don't have a denormalized counter

      return created;
    });

    return { report };
  }
}
