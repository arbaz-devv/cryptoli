import * as bcrypt from 'bcryptjs';
import { z } from 'zod';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function calculateOverallScore(
  criteriaScores: Record<string, number>,
): number {
  const weights: Record<string, number> = {
    security: 0.3,
    easeOfUse: 0.2,
    support: 0.2,
    features: 0.15,
    value: 0.15,
  };

  let totalScore = 0;
  let totalWeight = 0;

  for (const [key, value] of Object.entries(criteriaScores)) {
    const weight = weights[key] ?? 0.1;
    totalScore += value * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? totalScore / totalWeight : 0;
}

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(
      /^[a-zA-Z0-9_]+$/,
      'Username can only contain letters, numbers, and underscores',
    ),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export const updateProfileSchema = z.object({
  name: z.string().max(100).optional(),
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(30, 'Username must be at most 30 characters')
    .regex(
      /^[a-zA-Z0-9_]+$/,
      'Username can only contain letters, numbers, and underscores',
    )
    .optional(),
  bio: z.string().max(500).optional(),
});

export const createReviewSchema = z.object({
  title: z
    .string()
    .min(5, 'Title must be at least 5 characters')
    .max(200, 'Title must be less than 200 characters'),
  content: z.string().min(20, 'Review content must be at least 20 characters'),
  companyId: z.string().optional(),
  productId: z.string().optional(),
  overallScore: z.number().min(0).max(10),
  criteriaScores: z.record(z.string(), z.number()),
});

export const createCommentSchema = z.object({
  content: z.string().min(1).max(1000),
  reviewId: z.string().optional(),
  postId: z.string().optional(),
  complaintId: z.string().optional(),
  parentId: z.string().optional(),
});

export const createComplaintSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  companyId: z.string().optional(),
  productId: z.string().optional(),
});

export const createReplySchema = z.object({
  content: z.string().min(1).max(5000),
});

export type LoginDto = z.infer<typeof loginSchema>;
export type RegisterDto = z.infer<typeof registerSchema>;
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
export type CreateReviewDto = z.infer<typeof createReviewSchema>;
export type CreateCommentDto = z.infer<typeof createCommentSchema>;
export type CreateComplaintDto = z.infer<typeof createComplaintSchema>;
export type CreateReplyDto = z.infer<typeof createReplySchema>;
