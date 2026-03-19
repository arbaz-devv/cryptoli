import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { setupTestApp, teardownTestApp } from '../helpers/setup-app';
import { truncateAll, getTestPrisma, flushTestRedis, getTestRedis } from '../helpers/test-db.utils';

describe('Admin E2E', () => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    const setup = await setupTestApp();
    app = setup.app;
    server = setup.server;
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
  });

  afterAll(async () => {
    await getTestRedis().quit();
    await getTestPrisma().$disconnect();
    await teardownTestApp(app);
  });

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
        .set('X-Admin-Key', 'test-admin-key');

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
});
