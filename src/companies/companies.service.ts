import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(page: number, limit: number, category?: string, search?: string) {
    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [companies, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        include: {
          _count: {
            select: {
              reviews: { where: { status: 'APPROVED' } },
              followers: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.company.count({ where }),
    ]);

    return {
      companies,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getBySlug(slug: string, viewerId?: string | null) {
    const company = await this.prisma.company.findUnique({
      where: { slug },
      include: {
        _count: {
          select: {
            reviews: { where: { status: 'APPROVED' } },
            followers: true,
            products: true,
          },
        },
      },
    });

    if (!company) {
      throw new NotFoundError('Company not found');
    }

    const reviews = await this.prisma.review.findMany({
      where: { companyId: company.id, status: 'APPROVED' },
      select: { overallScore: true },
    });
    const averageScore =
      reviews.length > 0
        ? reviews.reduce((sum, r) => sum + r.overallScore, 0) / reviews.length
        : 0;

    let isFollowing = false;
    if (viewerId) {
      const follow = await this.prisma.companyFollow.findFirst({
        where: { userId: viewerId, companyId: company.id },
        select: { id: true },
      });
      isFollowing = Boolean(follow);
    }

    return { ...company, averageScore, viewerState: { isFollowing } };
  }

  async followCompany(userId: string, slug: string) {
    const company = await this.prisma.company.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!company) {
      throw new NotFoundError('Company not found');
    }

    try {
      await this.prisma.companyFollow.create({
        data: { userId, companyId: company.id },
      });
    } catch {
      // unique constraint — already following: treat as success
    }

    return { following: true };
  }

  async unfollowCompany(userId: string, slug: string) {
    const company = await this.prisma.company.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!company) {
      throw new NotFoundError('Company not found');
    }

    await this.prisma.companyFollow.deleteMany({
      where: { userId, companyId: company.id },
    });

    return { following: false };
  }
}
