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

describe('Analytics E2E', () => {
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

  describe('POST /api/analytics/track', () => {
    it('should accept a valid event and return { ok: true }', async () => {
      const res = await request(server)
        .post('/api/analytics/track')
        .set('Origin', 'http://localhost:3000')
        .send({ event: 'page_view', path: '/' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
    });

    it('should return { ok: true } for various event types', async () => {
      const events = [
        { event: 'page_view', path: '/companies' },
        { event: 'page_leave', path: '/' },
        { event: 'signup_started' },
      ];

      for (const body of events) {
        const res = await request(server)
          .post('/api/analytics/track')
          .set('Origin', 'http://localhost:3000')
          .send(body);

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ ok: true });
      }
    });

    it('should not write Redis keys when consent is undefined (GDPR opt-in)', async () => {
      const redis = getTestRedis();
      const today = new Date().toISOString().slice(0, 10);

      await request(server)
        .post('/api/analytics/track')
        .set('Origin', 'http://localhost:3000')
        .send({ event: 'page_view', path: '/test-no-consent' });

      // Allow any fire-and-forget writes to settle
      await new Promise((r) => setTimeout(r, 200));

      const pageviews = await redis.get(`analytics:pageviews:${today}`);
      expect(pageviews).toBeNull();
    });

    it('should not write Redis keys when consent is false', async () => {
      const redis = getTestRedis();
      const today = new Date().toISOString().slice(0, 10);

      await request(server)
        .post('/api/analytics/track')
        .set('Origin', 'http://localhost:3000')
        .send({
          event: 'page_view',
          path: '/test-false-consent',
          consent: false,
        });

      await new Promise((r) => setTimeout(r, 200));

      const pageviews = await redis.get(`analytics:pageviews:${today}`);
      expect(pageviews).toBeNull();
    });

    it('should write Redis keys when consent is true', async () => {
      const redis = getTestRedis();
      const today = new Date().toISOString().slice(0, 10);

      await request(server)
        .post('/api/analytics/track')
        .set('Origin', 'http://localhost:3000')
        .send({
          event: 'page_view',
          path: '/test-with-consent',
          consent: true,
        });

      await new Promise((r) => setTimeout(r, 200));

      const pageviews = await redis.get(`analytics:pageviews:${today}`);
      expect(Number(pageviews)).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/analytics/health', () => {
    it('should return 200 with all required status fields', async () => {
      const res = await request(server).get('/api/analytics/health');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('enabled');
      expect(res.body).toHaveProperty('configured');
      expect(res.body).toHaveProperty('connected');
      expect(res.body).toHaveProperty('lastError');
      expect(typeof res.body.enabled).toBe('boolean');
      expect(typeof res.body.configured).toBe('boolean');
      expect(typeof res.body.connected).toBe('boolean');
    });
  });

  describe('GET /api/analytics/stats', () => {
    it('should return 401 when no X-Analytics-Key header is provided', async () => {
      const res = await request(server).get('/api/analytics/stats');

      expect(res.status).toBe(401);
    });

    it('should return 401 when an incorrect X-Analytics-Key is provided', async () => {
      const res = await request(server)
        .get('/api/analytics/stats')
        .set('X-Analytics-Key', 'wrong-key');

      expect(res.status).toBe(401);
    });

    it('should return 200 with ok field when the correct X-Analytics-Key is provided', async () => {
      const res = await request(server)
        .get('/api/analytics/stats')
        .set('X-Analytics-Key', 'test-analytics-key');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('ok');
    });
  });

  describe('GET /api/analytics/realtime', () => {
    it('should return 401 when no X-Analytics-Key header is provided', async () => {
      const res = await request(server).get('/api/analytics/realtime');

      expect(res.status).toBe(401);
    });

    it('should return 200 with ok and activeNow when authenticated', async () => {
      const res = await request(server)
        .get('/api/analytics/realtime')
        .set('X-Analytics-Key', 'test-analytics-key');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('ok');
      expect(res.body.ok).toBe(true);
      expect(res.body).toHaveProperty('activeNow');
    });
  });
});
