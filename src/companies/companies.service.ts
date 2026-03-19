import { Injectable } from '@nestjs/common';
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

  async getBySlug(slug: string) {
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

    return { ...company, averageScore };
  }
}
