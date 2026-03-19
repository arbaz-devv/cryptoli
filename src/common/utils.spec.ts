import {
  hashPassword,
  verifyPassword,
  calculateOverallScore,
  registerSchema,
  loginSchema,
  changePasswordSchema,
  updateProfileSchema,
  createReviewSchema,
  createCommentSchema,
  createComplaintSchema,
  createReplySchema,
} from './utils';

describe('hashPassword / verifyPassword', () => {
  it('should round-trip correctly', async () => {
    const hash = await hashPassword('mysecret');
    expect(await verifyPassword('mysecret', hash)).toBe(true);
  });

  it('should reject wrong password', async () => {
    const hash = await hashPassword('mysecret');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});

describe('calculateOverallScore', () => {
  it('should compute weighted average for known criteria', () => {
    const score = calculateOverallScore({
      security: 10,
      easeOfUse: 10,
      support: 10,
      features: 10,
      value: 10,
    });
    expect(score).toBe(10);
  });

  it('should use 0.1 fallback weight for unknown keys', () => {
    const score = calculateOverallScore({ unknownCriteria: 5 });
    // 5 * 0.1 / 0.1 = 5
    expect(score).toBe(5);
  });

  it('should return 0 for empty object', () => {
    expect(calculateOverallScore({})).toBe(0);
  });

  it('should mix known and unknown weights correctly', () => {
    // security: 10*0.3=3, unknown: 0*0.1=0 => total 3 / (0.3+0.1) = 7.5
    const score = calculateOverallScore({ security: 10, unknown: 0 });
    expect(score).toBeCloseTo(7.5, 5);
  });
});

describe('Zod schemas', () => {
  describe('registerSchema', () => {
    it('should accept valid input', () => {
      const result = registerSchema.safeParse({
        email: 'a@b.com',
        username: 'user_1',
        password: '12345678',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid email', () => {
      const result = registerSchema.safeParse({
        email: 'not-email',
        username: 'user1',
        password: '12345678',
      });
      expect(result.success).toBe(false);
    });

    it('should reject short username', () => {
      const result = registerSchema.safeParse({
        email: 'a@b.com',
        username: 'ab',
        password: '12345678',
      });
      expect(result.success).toBe(false);
    });

    it('should reject username with special chars', () => {
      const result = registerSchema.safeParse({
        email: 'a@b.com',
        username: 'user@name',
        password: '12345678',
      });
      expect(result.success).toBe(false);
    });

    it('should reject short password', () => {
      const result = registerSchema.safeParse({
        email: 'a@b.com',
        username: 'user1',
        password: '1234567',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('loginSchema', () => {
    it('should accept valid input', () => {
      expect(loginSchema.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(true);
    });

    it('should reject empty password', () => {
      expect(loginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
    });
  });

  describe('changePasswordSchema', () => {
    it('should accept valid input', () => {
      expect(
        changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: '12345678' }).success,
      ).toBe(true);
    });

    it('should reject short new password', () => {
      expect(
        changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: '1234567' }).success,
      ).toBe(false);
    });
  });

  describe('updateProfileSchema', () => {
    it('should accept empty object', () => {
      expect(updateProfileSchema.safeParse({}).success).toBe(true);
    });

    it('should accept valid username and bio', () => {
      expect(
        updateProfileSchema.safeParse({ username: 'abc', bio: 'hello' }).success,
      ).toBe(true);
    });

    it('should reject bio over 500 chars', () => {
      expect(
        updateProfileSchema.safeParse({ bio: 'x'.repeat(501) }).success,
      ).toBe(false);
    });
  });

  describe('createReviewSchema', () => {
    const valid = {
      title: 'Valid Title Here',
      content: 'This is a review with at least twenty characters in it.',
      overallScore: 7,
      criteriaScores: { security: 8 },
    };

    it('should accept valid input', () => {
      expect(createReviewSchema.safeParse(valid).success).toBe(true);
    });

    it('should reject short title', () => {
      expect(createReviewSchema.safeParse({ ...valid, title: 'Hi' }).success).toBe(false);
    });

    it('should reject short content', () => {
      expect(createReviewSchema.safeParse({ ...valid, content: 'short' }).success).toBe(false);
    });

    it('should reject overallScore out of range', () => {
      expect(createReviewSchema.safeParse({ ...valid, overallScore: 11 }).success).toBe(false);
      expect(createReviewSchema.safeParse({ ...valid, overallScore: -1 }).success).toBe(false);
    });
  });

  describe('createCommentSchema', () => {
    it('should accept valid input', () => {
      expect(createCommentSchema.safeParse({ content: 'hi', reviewId: 'r1' }).success).toBe(true);
    });

    it('should reject empty content', () => {
      expect(createCommentSchema.safeParse({ content: '' }).success).toBe(false);
    });

    it('should reject content over 1000 chars', () => {
      expect(createCommentSchema.safeParse({ content: 'x'.repeat(1001) }).success).toBe(false);
    });
  });

  describe('createComplaintSchema', () => {
    it('should accept valid input', () => {
      expect(
        createComplaintSchema.safeParse({ title: 'Bad', content: 'Details here' }).success,
      ).toBe(true);
    });

    it('should reject empty title', () => {
      expect(
        createComplaintSchema.safeParse({ title: '', content: 'x' }).success,
      ).toBe(false);
    });
  });

  describe('createReplySchema', () => {
    it('should accept valid input', () => {
      expect(createReplySchema.safeParse({ content: 'reply' }).success).toBe(true);
    });

    it('should reject empty content', () => {
      expect(createReplySchema.safeParse({ content: '' }).success).toBe(false);
    });

    it('should reject content over 5000 chars', () => {
      expect(createReplySchema.safeParse({ content: 'x'.repeat(5001) }).success).toBe(false);
    });
  });
});
