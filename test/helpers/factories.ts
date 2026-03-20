import { PrismaClient } from '@prisma/client';
import { hashSync } from 'bcryptjs';

let counter = 0;

/** Reset counter between test suites to avoid collision across parallel runs */
export function resetFactoryCounter() {
  counter = 0;
}

export async function createTestUser(
  prisma: PrismaClient,
  overrides: Record<string, any> = {},
) {
  counter++;
  return prisma.user.create({
    data: {
      email: `user${counter}@test.com`,
      username: `testuser${counter}`,
      passwordHash: hashSync('password123', 1), // cost 1 for speed in tests
      ...overrides,
    },
  });
}

export async function createTestCompany(
  prisma: PrismaClient,
  overrides: Record<string, any> = {},
) {
  counter++;
  return prisma.company.create({
    data: {
      name: `Test Company ${counter}`,
      slug: `test-company-${counter}`,
      category: 'EXCHANGES',
      ...overrides,
    },
  });
}

export async function createTestReview(
  prisma: PrismaClient,
  authorId: string,
  overrides: Record<string, any> = {},
) {
  counter++;
  return prisma.review.create({
    data: {
      title: `Test Review ${counter}`,
      content: 'This is a test review with enough content to pass validation.',
      authorId,
      overallScore: 7.5,
      criteriaScores: {
        security: 8,
        easeOfUse: 7,
        support: 7,
        features: 8,
        value: 7,
      },
      status: 'APPROVED',
      ...overrides,
    },
  });
}

export async function createTestComplaint(
  prisma: PrismaClient,
  authorId: string,
  overrides: Record<string, any> = {},
) {
  counter++;
  return prisma.complaint.create({
    data: {
      title: `Test Complaint ${counter}`,
      content: 'This is a test complaint.',
      authorId,
      ...overrides,
    },
  });
}

export async function createTestComment(
  prisma: PrismaClient,
  authorId: string,
  reviewId: string,
  overrides: Record<string, any> = {},
) {
  counter++;
  return prisma.comment.create({
    data: {
      content: `Test comment ${counter}`,
      authorId,
      reviewId,
      ...overrides,
    },
  });
}
