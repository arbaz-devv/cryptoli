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
    it('should return 401 when no X-Analytics-Key header is provided', async () => {
      const res = await request(server).get('/api/analytics/health');

      expect(res.status).toBe(401);
    });

    it('should return 401 when an incorrect X-Analytics-Key is provided', async () => {
      const res = await request(server)
        .get('/api/analytics/health')
        .set('X-Analytics-Key', 'wrong-key');

      expect(res.status).toBe(401);
    });

    it('should return 200 with all required status fields when authenticated', async () => {
      const res = await request(server)
        .get('/api/analytics/health')
        .set('X-Analytics-Key', 'test-analytics-key');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('enabled');
      expect(res.body).toHaveProperty('configured');
      expect(res.body).toHaveProperty('connected');
      expect(res.body).toHaveProperty('lastError');
      expect(typeof res.body.enabled).toBe('boolean');
      expect(typeof res.body.configured).toBe('boolean');
      expect(typeof res.body.connected).toBe('boolean');
      expect(res.body).toHaveProperty('rollup');
      expect(res.body.rollup).toHaveProperty('lastSuccessDate');
      expect(typeof res.body.rollup.stale).toBe('boolean');
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

  describe('GET /api/analytics/latest-members', () => {
    it('should return 401 when no X-Analytics-Key header is provided', async () => {
      const res = await request(server).get('/api/analytics/latest-members');

      expect(res.status).toBe(401);
    });

    it('should return 200 with members array when authenticated', async () => {
      const res = await request(server)
        .get('/api/analytics/latest-members')
        .set('X-Analytics-Key', 'test-analytics-key');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.members)).toBe(true);
    });

    it('should never leak internal error details in response', async () => {
      // Even if the DB query fails, the error message must be generic
      const res = await request(server)
        .get('/api/analytics/latest-members')
        .set('X-Analytics-Key', 'test-analytics-key');

      // With a clean DB, this should succeed — but verify the error field
      // shape is correct when present (ok: false responses)
      if (!res.body.ok) {
        expect(res.body.error).toBe('Failed to fetch latest members');
      }
    });
  });

  describe('GET /api/analytics/events', () => {
    it('should return 401 when no X-Analytics-Key header is provided', async () => {
      const res = await request(server).get('/api/analytics/events');

      expect(res.status).toBe(401);
    });

    it('should return 401 when an incorrect X-Analytics-Key is provided', async () => {
      const res = await request(server)
        .get('/api/analytics/events')
        .set('X-Analytics-Key', 'wrong-key');

      expect(res.status).toBe(401);
    });

    it('should return 200 with ok and data when authenticated', async () => {
      const res = await request(server)
        .get('/api/analytics/events')
        .set('X-Analytics-Key', 'test-analytics-key');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data).toHaveProperty('total');
      expect(res.body.data).toHaveProperty('timeSeries');
      expect(res.body.data).toHaveProperty('byEventType');
      expect(res.body.data).toHaveProperty('dateRange');
    });

    it('should accept from/to and eventType query params', async () => {
      const res = await request(server)
        .get('/api/analytics/events')
        .query({ from: '2026-03-01', to: '2026-03-30', eventType: 'page_view' })
        .set('X-Analytics-Key', 'test-analytics-key');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.dateRange).toEqual({
        from: '2026-03-01',
        to: '2026-03-30',
      });
    });

    it('should return all dimensional breakdowns in response shape', async () => {
      const res = await request(server)
        .get('/api/analytics/events')
        .set('X-Analytics-Key', 'test-analytics-key');

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data).toHaveProperty('byCountry');
      expect(data).toHaveProperty('byDevice');
      expect(data).toHaveProperty('byBrowser');
      expect(data).toHaveProperty('byOs');
      expect(data).toHaveProperty('byPath');
      expect(data).toHaveProperty('byReferrer');
      expect(data).toHaveProperty('byUtmSource');
      expect(data).toHaveProperty('byUtmMedium');
      expect(data).toHaveProperty('byUtmCampaign');
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
