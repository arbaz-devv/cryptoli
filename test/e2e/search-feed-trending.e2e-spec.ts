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

describe('Search, Feed, and Trending E2E', () => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    const setup = await setupTestApp();
    app = setup.app;
    server = setup.server;
  });

  beforeEach(async () => {
    resetFactoryCounter();
    await truncateAll();
    await flushTestRedis();
  });

  afterAll(async () => {
    await getTestRedis().quit();
    await getTestPrisma().$disconnect();
    await teardownTestApp(app);
  });

  async function registerAndGetCookies(suffix?: string): Promise<string[]> {
    const unique = suffix ?? String(Date.now());
    const res = await request(server)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:3000')
      .send({
        email: `user${unique}@test.com`,
        username: `user${unique}`,
        password: 'password123',
      });
    return res.headers['set-cookie'] as string[];
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

  describe('GET /api/search', () => {
    it('should return a results structure even when no data exists', async () => {
      const res = await request(server).get('/api/search?q=bitcoin');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('results');
      const results = res.body.results;
      // When q is provided, all three buckets are returned (potentially empty arrays)
      expect(results).toHaveProperty('companies');
      expect(results).toHaveProperty('reviews');
      expect(results).toHaveProperty('users');
      expect(Array.isArray(results.companies)).toBe(true);
      expect(Array.isArray(results.reviews)).toBe(true);
      expect(Array.isArray(results.users)).toBe(true);
    });

    it('should return empty results object when query is omitted', async () => {
      const res = await request(server).get('/api/search');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('results');
      // Empty query → service returns {}
      expect(res.body.results).toEqual({});
    });

    it('should return matching users when a user exists', async () => {
      const unique = String(Date.now());
      await registerAndGetCookies(unique);

      const res = await request(server).get(`/api/search?q=user${unique}`);

      expect(res.status).toBe(200);
      expect(res.body.results.users.length).toBeGreaterThan(0);
      expect(res.body.results.users[0].username).toContain(unique);
    });
  });

  describe('GET /api/feed', () => {
    it('should return items array and pagination when no content exists', async () => {
      const res = await request(server).get('/api/feed?page=1&limit=10');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('pagination');
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.pagination).toHaveProperty('page');
      expect(res.body.pagination).toHaveProperty('limit');
      expect(res.body.pagination).toHaveProperty('total');
      expect(res.body.pagination).toHaveProperty('totalPages');
    });

    it('should include a review in the feed after it is approved', async () => {
      const cookies = await registerAndGetCookies();

      // Create a review via the API (it will be in PENDING initially)
      const createRes = await request(server)
        .post('/api/reviews')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send(validReview);

      expect(createRes.status).toBe(201);

      // Directly approve the review in the DB so it appears in the feed
      await getTestPrisma().review.update({
        where: { id: createRes.body.id },
        data: { status: 'APPROVED' },
      });

      const feedRes = await request(server).get('/api/feed?page=1&limit=10');

      expect(feedRes.status).toBe(200);
      expect(feedRes.body.items.length).toBeGreaterThan(0);
      const reviewItem = feedRes.body.items.find(
        (item: any) => item.id === createRes.body.id,
      );
      expect(reviewItem).toBeDefined();
      expect(reviewItem.type).toBe('review');
    });

    it('should return correct pagination metadata', async () => {
      const res = await request(server).get('/api/feed?page=1&limit=10');

      expect(res.status).toBe(200);
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(10);
    });
  });

  describe('GET /api/trending', () => {
    it('should return trendingNow and topRatedThisWeek arrays', async () => {
      const res = await request(server).get('/api/trending');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('trendingNow');
      expect(res.body).toHaveProperty('topRatedThisWeek');
      expect(Array.isArray(res.body.trendingNow)).toBe(true);
      expect(Array.isArray(res.body.topRatedThisWeek)).toBe(true);
    });

    it('should include an approved review in trending results', async () => {
      const cookies = await registerAndGetCookies();

      const createRes = await request(server)
        .post('/api/reviews')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send(validReview);

      expect(createRes.status).toBe(201);

      await getTestPrisma().review.update({
        where: { id: createRes.body.id },
        data: { status: 'APPROVED' },
      });

      const trendingRes = await request(server).get('/api/trending');

      expect(trendingRes.status).toBe(200);
      expect(trendingRes.body.trendingNow.length).toBeGreaterThan(0);
      const item = trendingRes.body.trendingNow[0];
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('averageScore');
      expect(item).toHaveProperty('likes');
    });
  });
});
