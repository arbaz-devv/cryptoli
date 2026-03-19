import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { setupTestApp, teardownTestApp } from '../helpers/setup-app';
import { truncateAll, getTestPrisma, flushTestRedis, getTestRedis } from '../helpers/test-db.utils';
import { createTestCompany, resetFactoryCounter } from '../helpers/factories';
import { PrismaClient } from '@prisma/client';

describe('Reviews E2E', () => {
  let app: INestApplication;
  let server: any;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const setup = await setupTestApp();
    app = setup.app;
    server = setup.server;
    prisma = getTestPrisma();
  });

  beforeEach(async () => {
    resetFactoryCounter();
    await truncateAll(prisma);
    await flushTestRedis();
  });

  afterAll(async () => {
    await getTestRedis().quit();
    await prisma.$disconnect();
    await teardownTestApp(app);
  });

  async function registerAndGetCookies(): Promise<string[]> {
    const res = await request(server)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:3000')
      .send({
        email: `user${Date.now()}@test.com`,
        username: `user${Date.now()}`,
        password: 'password123',
      });
    return res.headers['set-cookie'] as unknown as string[];
  }

  const validReview = {
    title: 'Great Exchange Platform',
    content: 'This is a detailed review with enough content to pass validation easily.',
    overallScore: 8,
    criteriaScores: { security: 9, easeOfUse: 8, support: 7, features: 8, value: 7 },
  };

  describe('POST /api/reviews', () => {
    it('should create review when authenticated', async () => {
      const cookies = await registerAndGetCookies();

      const res = await request(server)
        .post('/api/reviews')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send(validReview);

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.title).toBe(validReview.title);
    });

    it('should reject unauthenticated create', async () => {
      const res = await request(server)
        .post('/api/reviews')
        .set('Origin', 'http://localhost:3000')
        .send(validReview);

      expect(res.status).toBe(401);
    });

    it('should reject invalid body', async () => {
      const cookies = await registerAndGetCookies();

      const res = await request(server)
        .post('/api/reviews')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({ title: 'Hi', content: 'short' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/reviews', () => {
    it('should list reviews with pagination', async () => {
      const cookies = await registerAndGetCookies();

      // Create a review
      await request(server)
        .post('/api/reviews')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send(validReview);

      const res = await request(server)
        .get('/api/reviews?page=1&limit=10');

      expect(res.status).toBe(200);
      expect(res.body.reviews).toBeDefined();
      expect(res.body.pagination).toBeDefined();
    });
  });

  describe('POST /api/reviews/:id/vote', () => {
    it('should vote on a review and update helpfulCount', async () => {
      const cookies = await registerAndGetCookies();
      const voterCookies = await registerAndGetCookies();

      const createRes = await request(server)
        .post('/api/reviews')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send(validReview);

      const reviewId = createRes.body.id;

      const voteRes = await request(server)
        .post(`/api/reviews/${reviewId}/vote`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', voterCookies)
        .send({ voteType: 'UP' });

      expect(voteRes.status).toBeLessThan(300);

      // Verify helpfulCount updated
      const getRes = await request(server).get(`/api/reviews/${reviewId}`);
      expect(getRes.body.helpfulCount).toBe(1);
    });
  });
});
