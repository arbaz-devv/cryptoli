import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { setupTestApp, teardownTestApp } from '../helpers/setup-app';
import {
  truncateAll,
  getTestPrisma,
  flushTestRedis,
  getTestRedis,
} from '../helpers/test-db.utils';
import { createTestUser, createTestReview } from '../helpers/factories';

describe('Admin E2E', () => {
  let app: INestApplication;
  let server: any;
  let prisma: PrismaClient;
  const ADMIN_KEY = 'test-admin-key';

  beforeAll(async () => {
    const setup = await setupTestApp();
    app = setup.app;
    server = setup.server;
    prisma = getTestPrisma();
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
  });

  afterAll(async () => {
    await getTestRedis().quit();
    await prisma.$disconnect();
    await teardownTestApp(app);
  });

  /** Create a user and seed sessions with enrichment fields */
  async function seedUserWithSessions() {
    const user = await createTestUser(prisma);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);

    await prisma.session.createMany({
      data: [
        {
          userId: user.id,
          token: `tok-${Date.now()}-1`,
          expiresAt: new Date(now.getTime() + 86_400_000 * 30),
          createdAt: yesterday,
          ip: '10.0.0.1',
          ipHash: 'a'.repeat(64),
          userAgent: 'Mozilla/5.0 (Linux; Android)',
          device: 'mobile',
          browser: 'Firefox',
          os: 'Android',
          country: 'DE',
          timezone: 'Europe/Berlin',
          trigger: 'login',
        },
        {
          userId: user.id,
          token: `tok-${Date.now()}-2`,
          expiresAt: new Date(now.getTime() + 86_400_000 * 30),
          createdAt: now,
          ip: '192.168.1.1',
          ipHash: 'b'.repeat(64),
          userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
          device: 'desktop',
          browser: 'Chrome',
          os: 'Windows',
          country: 'US',
          timezone: 'America/New_York',
          trigger: 'login',
        },
      ],
    });

    return user;
  }

  describe('POST /api/admin/auth/login', () => {
    it('should return JWT for valid admin credentials', async () => {
      const res = await request(server)
        .post('/api/admin/auth/login')
        .send({ email: 'admin@test.com', password: 'testpassword' });

      expect(res.status).toBe(201);
      expect(res.body.token).toBeDefined();
    });

    it('should reject wrong password', async () => {
      const res = await request(server)
        .post('/api/admin/auth/login')
        .send({ email: 'admin@test.com', password: 'wrongpassword' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/admin/stats', () => {
    it('should return stats with admin API key', async () => {
      const res = await request(server)
        .get('/api/admin/stats')
        .set('X-Admin-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.totalUsers).toBeDefined();
    });

    it('should reject without admin key', async () => {
      const res = await request(server).get('/api/admin/stats');

      expect(res.status).toBe(401);
    });

    it('should accept JWT auth', async () => {
      const loginRes = await request(server)
        .post('/api/admin/auth/login')
        .send({ email: 'admin@test.com', password: 'testpassword' });

      const token = loginRes.body.token;

      const res = await request(server)
        .get('/api/admin/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/admin/users/:id (getUserDetail with real session data)', () => {
    it('should return device/country from most recent session', async () => {
      const user = await seedUserWithSessions();

      const res = await request(server)
        .get(`/api/admin/users/${user.id}`)
        .set('X-Admin-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      // Most recent session is the desktop/Chrome/US one
      expect(res.body.user.device).toBe('desktop');
      expect(res.body.user.browser).toBe('Chrome');
      expect(res.body.user.os).toBe('Windows');
      expect(res.body.user.country).toBe('US');
      expect(res.body.user.timezone).toBe('America/New_York');
      expect(res.body.user.loginCount).toBe(2);
    });

    it('should return registrationIp fallback from earliest session', async () => {
      const user = await seedUserWithSessions();

      const res = await request(server)
        .get(`/api/admin/users/${user.id}`)
        .set('X-Admin-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      // No user.registrationIp set, falls back to earliest session IP
      expect(res.body.user.registrationIp).toBe('10.0.0.1');
      expect(res.body.user.registrationCountry).toBe('DE');
    });
  });

  describe('GET /api/admin/users/:id/sessions', () => {
    it('should reject without admin key', async () => {
      const res = await request(server).get('/api/admin/users/any-id/sessions');

      expect(res.status).toBe(401);
    });

    it('should return paginated sessions with enrichment fields', async () => {
      const user = await seedUserWithSessions();

      const res = await request(server)
        .get(`/api/admin/users/${user.id}/sessions`)
        .set('X-Admin-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(2);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({
          page: 1,
          total: 2,
          totalPages: 1,
        }),
      );

      // Sessions ordered by createdAt desc — most recent first
      const first = res.body.sessions[0];
      expect(first.device).toBe('desktop');
      expect(first.browser).toBe('Chrome');
      expect(first.country).toBe('US');
      expect(first.ipHash).toBe('b'.repeat(64));
      expect(first.trigger).toBe('login');
      expect(first.createdAt).toBeDefined();
      expect(first.expiresAt).toBeDefined();
    });

    it('should respect pagination parameters', async () => {
      const user = await seedUserWithSessions();

      const res = await request(server)
        .get(`/api/admin/users/${user.id}/sessions?page=1&limit=1`)
        .set('X-Admin-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.pagination.total).toBe(2);
      expect(res.body.pagination.totalPages).toBe(2);
    });
  });

  describe('GET /api/admin/users/:id/sessions/export', () => {
    it('should reject without admin key', async () => {
      const res = await request(server).get(
        '/api/admin/users/any-id/sessions/export?format=csv',
      );

      expect(res.status).toBe(401);
    });

    it('should return CSV with Content-Disposition header and no raw IP', async () => {
      const user = await seedUserWithSessions();

      const res = await request(server)
        .get(`/api/admin/users/${user.id}/sessions/export?format=csv`)
        .set('X-Admin-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['cache-control']).toBe('no-store');

      const csv = res.text;
      // UTF-8 BOM
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      // Header row present
      expect(csv).toContain('IP Hash,User Agent,Device,Browser,OS');
      // Data rows present
      expect(csv).toContain('b'.repeat(64));
      // Raw IP must NOT appear in CSV — only hash
      expect(csv).not.toContain('10.0.0.1');
      expect(csv).not.toContain('192.168.1.1');
    });

    it('should return JSON array for json format', async () => {
      const user = await seedUserWithSessions();

      const res = await request(server)
        .get(`/api/admin/users/${user.id}/sessions/export?format=json`)
        .set('X-Admin-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].ipHash).toBeDefined();
      expect(res.body[0].device).toBeDefined();
    });
  });

  describe('GET /api/admin/users/:id/activity', () => {
    it('should reject without admin key', async () => {
      const res = await request(server).get('/api/admin/users/any-id/activity');

      expect(res.status).toBe(401);
    });

    it('should return activities with type discriminators sorted by createdAt desc', async () => {
      const user = await createTestUser(prisma);
      const review = await createTestReview(prisma, user.id);
      await prisma.comment.create({
        data: {
          content: 'Great review!',
          authorId: user.id,
          reviewId: review.id,
        },
      });

      const res = await request(server)
        .get(`/api/admin/users/${user.id}/activity`)
        .set('X-Admin-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.activities).toHaveLength(2);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ total: 2 }),
      );

      const types = res.body.activities.map((a: any) => a.type);
      expect(types).toContain('review');
      expect(types).toContain('comment');

      // Each activity has required shape
      for (const activity of res.body.activities) {
        expect(activity.id).toBeDefined();
        expect(activity.summary).toBeDefined();
        expect(activity.createdAt).toBeDefined();
        expect(typeof activity.type).toBe('string');
      }

      // Comment is newer, so it should come first
      expect(res.body.activities[0].type).toBe('comment');
      expect(res.body.activities[0].summary).toContain('Commented');
    });

    it('should return empty activities for user with no activity', async () => {
      const user = await createTestUser(prisma);

      const res = await request(server)
        .get(`/api/admin/users/${user.id}/activity`)
        .set('X-Admin-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.activities).toHaveLength(0);
      expect(res.body.pagination.total).toBe(0);
    });
  });

  describe('POST /api/admin/analytics/rollup', () => {
    it('should reject without admin key', async () => {
      const res = await request(server)
        .post('/api/admin/analytics/rollup')
        .send({});

      expect(res.status).toBe(401);
    });

    it('should return rollup response shape with ok, rolledUp, skipped, errors, durationMs', async () => {
      const res = await request(server)
        .post('/api/admin/analytics/rollup')
        .set('X-Admin-Key', ADMIN_KEY)
        .send({ date: '2026-03-20' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(
        expect.objectContaining({
          ok: expect.any(Boolean),
        }),
      );
      // When rollup succeeds, these fields are present
      if (res.body.ok) {
        expect(typeof res.body.rolledUp).toBe('number');
        expect(typeof res.body.skipped).toBe('number');
        expect(typeof res.body.errors).toBe('number');
        expect(typeof res.body.durationMs).toBe('number');
      }
    });

    it('should accept empty body and default to yesterday', async () => {
      const res = await request(server)
        .post('/api/admin/analytics/rollup')
        .set('X-Admin-Key', ADMIN_KEY)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.ok).toBeDefined();
    });
  });
});
