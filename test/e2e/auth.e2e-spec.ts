import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { setupTestApp, teardownTestApp } from '../helpers/setup-app';
import {
  truncateAll,
  getTestPrisma,
  flushTestRedis,
  getTestRedis,
} from '../helpers/test-db.utils';

describe('Auth E2E', () => {
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

  const validUser = {
    email: 'test@example.com',
    username: 'testuser',
    password: 'password123',
  };

  describe('POST /api/auth/register', () => {
    it('should register a new user and set session cookie', async () => {
      const res = await request(server)
        .post('/api/auth/register')
        .set('Origin', 'http://localhost:3000')
        .send(validUser);

      expect(res.status).toBe(201);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(validUser.email);
      expect(res.body.user.username).toBe(validUser.username);
      expect(res.body.user).not.toHaveProperty('passwordHash');
      // Session cookie should be set
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
    });

    it('should reject duplicate email', async () => {
      await request(server)
        .post('/api/auth/register')
        .set('Origin', 'http://localhost:3000')
        .send(validUser);

      const res = await request(server)
        .post('/api/auth/register')
        .set('Origin', 'http://localhost:3000')
        .send({ ...validUser, username: 'other' });

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject invalid body (Zod validation)', async () => {
      const res = await request(server)
        .post('/api/auth/register')
        .set('Origin', 'http://localhost:3000')
        .send({ email: 'bad', username: 'ab', password: '123' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login with correct credentials and set cookie', async () => {
      await request(server)
        .post('/api/auth/register')
        .set('Origin', 'http://localhost:3000')
        .send(validUser);

      const res = await request(server)
        .post('/api/auth/login')
        .set('Origin', 'http://localhost:3000')
        .send({ email: validUser.email, password: validUser.password });

      expect(res.status).toBe(201);
      expect(res.body.user).toBeDefined();
    });

    it('should reject wrong password', async () => {
      await request(server)
        .post('/api/auth/register')
        .set('Origin', 'http://localhost:3000')
        .send(validUser);

      const res = await request(server)
        .post('/api/auth/login')
        .set('Origin', 'http://localhost:3000')
        .send({ email: validUser.email, password: 'wrongpassword' });

      expect(res.status).toBe(401);
    });

    it('should reject non-existent user (same status as wrong password)', async () => {
      const res = await request(server)
        .post('/api/auth/login')
        .set('Origin', 'http://localhost:3000')
        .send({ email: 'noone@test.com', password: 'whatever1' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return user when authenticated', async () => {
      const registerRes = await request(server)
        .post('/api/auth/register')
        .set('Origin', 'http://localhost:3000')
        .send(validUser);

      const cookies = registerRes.headers['set-cookie'];

      const res = await request(server)
        .get('/api/auth/me')
        .set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(validUser.email);
    });

    it('should return null user when not authenticated', async () => {
      const res = await request(server).get('/api/auth/me');

      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should clear session and cookie', async () => {
      const registerRes = await request(server)
        .post('/api/auth/register')
        .set('Origin', 'http://localhost:3000')
        .send(validUser);

      const cookies = registerRes.headers['set-cookie'];

      const logoutRes = await request(server)
        .post('/api/auth/logout')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      expect(logoutRes.status).toBeLessThan(300);

      // Verify session is gone
      const meRes = await request(server)
        .get('/api/auth/me')
        .set('Cookie', cookies);

      expect(meRes.body.user).toBeNull();
    });
  });
});
