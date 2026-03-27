import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { setupTestApp, teardownTestApp } from '../helpers/setup-app';
import {
  truncateAll,
  getTestPrisma,
  flushTestRedis,
  getTestRedis,
} from '../helpers/test-db.utils';
import { resetFactoryCounter } from '../helpers/factories';
import { PrismaClient } from '@prisma/client';

describe('Comments E2E', () => {
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
    const ts = Date.now();
    const res = await request(server)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:3000')
      .send({
        email: `user${ts}@test.com`,
        username: `user${ts}`,
        password: 'password123',
      });
    return res.headers['set-cookie'] as unknown as string[];
  }

  const validReview = {
    title: 'Great Exchange Platform',
    content:
      'This is a detailed review with enough content to pass validation easily.',
    overallScore: 8,
    criteriaScores: {
      security: 9,
      easeOfUse: 8,
      support: 7,
      features: 8,
      value: 7,
    },
  };

  async function createReview(cookies: string[]): Promise<string> {
    const res = await request(server)
      .post('/api/reviews')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', cookies)
      .send(validReview);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  describe('POST /api/comments', () => {
    it('should create a comment on a review and return it with author', async () => {
      const cookies = await registerAndGetCookies();
      const reviewId = await createReview(cookies);

      const res = await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({ content: 'This is a helpful comment.', reviewId });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.content).toBe('This is a helpful comment.');
      expect(res.body.author).toBeDefined();
      expect(res.body.author.username).toBeDefined();
      expect(res.body._count).toBeDefined();
    });

    it('should create a reply with parentId and fetch it via paginated list', async () => {
      const cookies = await registerAndGetCookies();
      const reviewId = await createReview(cookies);

      const parentRes = await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({ content: 'Parent comment.', reviewId });

      expect(parentRes.status).toBe(201);
      const parentId = parentRes.body.id as string;

      const replyRes = await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({ content: 'Reply to parent.', reviewId, parentId });

      expect(replyRes.status).toBe(201);
      expect(replyRes.body.id).toBeDefined();
      expect(replyRes.body.content).toBe('Reply to parent.');

      // getById returns the comment with reply count, not inline replies
      const getRes = await request(server).get(
        `/api/comments/${parentId}?reviewId=${reviewId}`,
      );

      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(parentId);
      expect(getRes.body._count.replies).toBe(1);

      // Fetch replies via paginated list endpoint with parentId
      const repliesRes = await request(server).get(
        `/api/comments?reviewId=${reviewId}&parentId=${parentId}`,
      );

      expect(repliesRes.status).toBe(200);
      expect(repliesRes.body.comments).toBeDefined();
      expect(repliesRes.body.comments.length).toBe(1);
      expect(repliesRes.body.comments[0].id).toBe(replyRes.body.id);
      expect(repliesRes.body.comments[0].content).toBe('Reply to parent.');
      expect(repliesRes.body.pagination).toBeDefined();
      expect(repliesRes.body.pagination.hasMore).toBe(false);
    });

    it('should reject unauthenticated comment creation with 401', async () => {
      const cookies = await registerAndGetCookies();
      const reviewId = await createReview(cookies);

      const res = await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .send({ content: 'Unauthenticated comment.', reviewId });

      expect(res.status).toBe(401);
    });

    it('should reject comment with empty content', async () => {
      const cookies = await registerAndGetCookies();
      const reviewId = await createReview(cookies);

      const res = await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({ content: '', reviewId });

      expect(res.status).toBe(400);
    });

    it('should reject comment without a target (no reviewId/postId/complaintId)', async () => {
      const cookies = await registerAndGetCookies();

      const res = await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({ content: 'No target.' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/comments', () => {
    it('should list comments for a review', async () => {
      const cookies = await registerAndGetCookies();
      const reviewId = await createReview(cookies);

      await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({ content: 'First comment.', reviewId });

      await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({ content: 'Second comment.', reviewId });

      const res = await request(server).get(
        `/api/comments?reviewId=${reviewId}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.comments).toBeDefined();
      expect(Array.isArray(res.body.comments)).toBe(true);
      expect(res.body.comments.length).toBe(2);
    });

    it('should return an empty comments array when there are none', async () => {
      const cookies = await registerAndGetCookies();
      const reviewId = await createReview(cookies);

      const res = await request(server).get(
        `/api/comments?reviewId=${reviewId}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.comments).toBeDefined();
      expect(res.body.comments.length).toBe(0);
    });
  });

  describe('GET /api/comments/:id', () => {
    it('should return a single comment with reply count', async () => {
      const cookies = await registerAndGetCookies();
      const reviewId = await createReview(cookies);

      const parentRes = await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({ content: 'Top-level comment.', reviewId });

      expect(parentRes.status).toBe(201);
      const parentId = parentRes.body.id as string;

      const getRes = await request(server).get(
        `/api/comments/${parentId}?reviewId=${reviewId}`,
      );

      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(parentId);
      expect(getRes.body.content).toBe('Top-level comment.');
      expect(getRes.body.author).toBeDefined();
      expect(getRes.body._count).toBeDefined();
      expect(getRes.body._count.replies).toBe(0);
    });
  });

  describe('POST /api/comments/:id/vote', () => {
    it('should vote UP on a comment and return updated helpfulCount', async () => {
      const authorCookies = await registerAndGetCookies();
      const voterCookies = await registerAndGetCookies();
      const reviewId = await createReview(authorCookies);

      const commentRes = await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', authorCookies)
        .send({ content: 'Voteable comment.', reviewId });

      expect(commentRes.status).toBe(201);
      const commentId = commentRes.body.id as string;

      const voteRes = await request(server)
        .post(`/api/comments/${commentId}/vote`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', voterCookies)
        .send({ voteType: 'UP' });

      expect(voteRes.status).toBe(201);
      expect(voteRes.body.voteType).toBe('UP');
      expect(voteRes.body.helpfulCount).toBe(1);
      expect(voteRes.body.downVoteCount).toBe(0);
    });

    it('should toggle vote off when voting the same type twice', async () => {
      const authorCookies = await registerAndGetCookies();
      const voterCookies = await registerAndGetCookies();
      const reviewId = await createReview(authorCookies);

      const commentRes = await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', authorCookies)
        .send({ content: 'Toggle vote comment.', reviewId });

      expect(commentRes.status).toBe(201);
      const commentId = commentRes.body.id as string;

      // First vote
      await request(server)
        .post(`/api/comments/${commentId}/vote`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', voterCookies)
        .send({ voteType: 'UP' });

      // Second vote (same type — should toggle off)
      const toggleRes = await request(server)
        .post(`/api/comments/${commentId}/vote`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', voterCookies)
        .send({ voteType: 'UP' });

      expect(toggleRes.status).toBe(201);
      expect(toggleRes.body.voteType).toBeNull();
      expect(toggleRes.body.helpfulCount).toBe(0);
    });

    it('should reject unauthenticated vote with 401', async () => {
      const cookies = await registerAndGetCookies();
      const reviewId = await createReview(cookies);

      const commentRes = await request(server)
        .post('/api/comments')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({ content: 'Comment to vote on.', reviewId });

      expect(commentRes.status).toBe(201);
      const commentId = commentRes.body.id as string;

      const voteRes = await request(server)
        .post(`/api/comments/${commentId}/vote`)
        .set('Origin', 'http://localhost:3000')
        .send({ voteType: 'UP' });

      expect(voteRes.status).toBe(401);
    });
  });
});
