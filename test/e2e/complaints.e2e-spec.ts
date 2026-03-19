import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { setupTestApp, teardownTestApp } from '../helpers/setup-app';
import {
  truncateAll,
  getTestPrisma,
  flushTestRedis,
  getTestRedis,
} from '../helpers/test-db.utils';
import { createTestCompany, resetFactoryCounter } from '../helpers/factories';
import { PrismaClient } from '@prisma/client';

describe('Complaints E2E', () => {
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
    return res.headers['set-cookie'] as string[];
  }

  describe('POST /api/complaints', () => {
    it('should create a complaint when authenticated with a valid companyId', async () => {
      const cookies = await registerAndGetCookies();
      const company = await createTestCompany(prisma);

      const res = await request(server)
        .post('/api/complaints')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({
          title: 'Funds withheld without explanation',
          content:
            'My withdrawal has been pending for over two weeks with no response from support.',
          companyId: company.id,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.title).toBe('Funds withheld without explanation');
      expect(res.body.companyId).toBe(company.id);
      expect(res.body.status).toBe('OPEN');
      expect(res.body.author).toBeDefined();
    });

    it('should return 401 when unauthenticated', async () => {
      const company = await createTestCompany(prisma);

      const res = await request(server)
        .post('/api/complaints')
        .set('Origin', 'http://localhost:3000')
        .send({
          title: 'Funds withheld without explanation',
          content:
            'My withdrawal has been pending for over two weeks with no response from support.',
          companyId: company.id,
        });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/complaints', () => {
    it('should return complaints with pagination', async () => {
      const cookies = await registerAndGetCookies();
      const company = await createTestCompany(prisma);

      await request(server)
        .post('/api/complaints')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies)
        .send({
          title: 'Delayed withdrawal issue',
          content:
            'My withdrawal has been pending for over two weeks with no response from support.',
          companyId: company.id,
        });

      const res = await request(server).get('/api/complaints?page=1&limit=10');

      expect(res.status).toBe(200);
      expect(res.body.complaints).toBeDefined();
      expect(Array.isArray(res.body.complaints)).toBe(true);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /api/complaints/:id/vote', () => {
    it('should cast an UP vote and verify helpfulCount via GET', async () => {
      const authorCookies = await registerAndGetCookies();
      const voterCookies = await registerAndGetCookies();
      const company = await createTestCompany(prisma);

      const createRes = await request(server)
        .post('/api/complaints')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', authorCookies)
        .send({
          title: 'Unjustified account suspension',
          content:
            'My account was suspended without any prior notice or explanation from the platform.',
          companyId: company.id,
        });

      expect(createRes.status).toBe(201);
      const complaintId = createRes.body.id;

      const voteRes = await request(server)
        .post(`/api/complaints/${complaintId}/vote`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', voterCookies)
        .send({ voteType: 'UP' });

      expect(voteRes.status).toBeLessThan(300);
      expect(voteRes.body.voteType).toBe('UP');
      expect(voteRes.body.helpfulCount).toBe(1);
      expect(voteRes.body.downVoteCount).toBe(0);

      // Verify the recount is persisted and reflected on the GET endpoint
      const getRes = await request(server).get(
        `/api/complaints/${complaintId}`,
      );

      expect(getRes.status).toBe(200);
      expect(getRes.body.helpfulCount).toBe(1);
      expect(getRes.body.downVoteCount).toBe(0);
    });

    it('should toggle vote off when the same voteType is cast twice', async () => {
      const authorCookies = await registerAndGetCookies();
      const voterCookies = await registerAndGetCookies();
      const company = await createTestCompany(prisma);

      const createRes = await request(server)
        .post('/api/complaints')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', authorCookies)
        .send({
          title: 'Hidden fees charged unexpectedly',
          content:
            'I was charged hidden fees that were not disclosed anywhere in the terms of service.',
          companyId: company.id,
        });

      const complaintId = createRes.body.id;

      // First vote
      await request(server)
        .post(`/api/complaints/${complaintId}/vote`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', voterCookies)
        .send({ voteType: 'UP' });

      // Second identical vote — should toggle off
      const secondVoteRes = await request(server)
        .post(`/api/complaints/${complaintId}/vote`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', voterCookies)
        .send({ voteType: 'UP' });

      expect(secondVoteRes.status).toBeLessThan(300);
      expect(secondVoteRes.body.voteType).toBeNull();
      expect(secondVoteRes.body.helpfulCount).toBe(0);

      const getRes = await request(server).get(
        `/api/complaints/${complaintId}`,
      );
      expect(getRes.body.helpfulCount).toBe(0);
    });
  });

  describe('POST /api/complaints/:id/reply', () => {
    it('should allow an admin to post a reply and have it appear on GET :id', async () => {
      const authorCookies = await registerAndGetCookies();
      const company = await createTestCompany(prisma);

      const createRes = await request(server)
        .post('/api/complaints')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', authorCookies)
        .send({
          title: 'Customer support completely unresponsive',
          content:
            'I have submitted five support tickets over the past month with zero replies from the team.',
          companyId: company.id,
        });

      expect(createRes.status).toBe(201);
      const complaintId = createRes.body.id;

      const replyRes = await request(server)
        .post(`/api/complaints/${complaintId}/reply`)
        .set('Origin', 'http://localhost:3000')
        .set('X-Admin-Key', 'test-admin-key')
        .send({ content: 'We apologise for the delay and are looking into this.' });

      expect(replyRes.status).toBe(201);
      expect(replyRes.body.id).toBeDefined();
      expect(replyRes.body.content).toBe(
        'We apologise for the delay and are looking into this.',
      );
      expect(replyRes.body.complaintId).toBe(complaintId);

      // Verify reply appears when fetching the complaint by id
      const getRes = await request(server).get(
        `/api/complaints/${complaintId}`,
      );

      expect(getRes.status).toBe(200);
      expect(getRes.body.replies).toBeDefined();
      expect(Array.isArray(getRes.body.replies)).toBe(true);
      expect(getRes.body.replies).toHaveLength(1);
      expect(getRes.body.replies[0].content).toBe(
        'We apologise for the delay and are looking into this.',
      );

      // Status should have been updated to IN_PROGRESS
      expect(getRes.body.status).toBe('IN_PROGRESS');
    });

    it('should return 401 when a non-admin attempts to post a reply', async () => {
      const authorCookies = await registerAndGetCookies();
      const company = await createTestCompany(prisma);

      const createRes = await request(server)
        .post('/api/complaints')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', authorCookies)
        .send({
          title: 'Withdrawal blocked for no reason',
          content:
            'My withdrawal request has been blocked and no reason has been provided by the platform.',
          companyId: company.id,
        });

      const complaintId = createRes.body.id;

      // Attempt reply without admin key
      const replyRes = await request(server)
        .post(`/api/complaints/${complaintId}/reply`)
        .set('Origin', 'http://localhost:3000')
        .send({ content: 'This should not be allowed.' });

      expect(replyRes.status).toBe(401);
    });
  });
});
