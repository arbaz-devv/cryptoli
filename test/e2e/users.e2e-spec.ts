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

describe('Users E2E', () => {
  let app: INestApplication;
  let server: any;

  let userCounter = 0;

  beforeAll(async () => {
    const setup = await setupTestApp();
    app = setup.app;
    server = setup.server;
  });

  beforeEach(async () => {
    resetFactoryCounter();
    userCounter = 0;
    await truncateAll();
    await flushTestRedis();
  });

  afterAll(async () => {
    await getTestRedis().quit();
    await getTestPrisma().$disconnect();
    await teardownTestApp(app);
  });

  async function registerUser(): Promise<{ cookies: string[]; username: string }> {
    userCounter++;
    const suffix = `${Date.now()}${userCounter}`;
    const email = `user${suffix}@test.com`;
    const username = `user${suffix}`;

    const res = await request(server)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:3000')
      .send({ email, username, password: 'password123' });

    expect(res.status).toBe(201);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    return { cookies, username };
  }

  describe('GET /api/users/:username', () => {
    it('should return user, stats, and viewerState for a public profile', async () => {
      const { username } = await registerUser();

      const res = await request(server).get(`/api/users/${username}`);

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe(username);
      expect(res.body.stats).toBeDefined();
      expect(typeof res.body.stats.followersCount).toBe('number');
      expect(typeof res.body.stats.followingCount).toBe('number');
      expect(typeof res.body.stats.postsCount).toBe('number');
      expect(typeof res.body.stats.complaintsCount).toBe('number');
      expect(res.body.viewerState).toBeDefined();
      expect(res.body.viewerState.isFollowing).toBe(false);
    });

    it('should not expose passwordHash in the response', async () => {
      const { username } = await registerUser();

      const res = await request(server).get(`/api/users/${username}`);

      expect(res.status).toBe(200);
      expect(res.body.user).not.toHaveProperty('passwordHash');
    });

    it('should return 404 for a non-existent username', async () => {
      const res = await request(server).get('/api/users/doesnotexist999');

      expect(res.status).toBe(404);
    });

    it('should set viewerState.isFollowing true when the viewer follows the user', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies: viewerCookies, username: viewerUsername } =
        await registerUser();

      await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', viewerCookies);

      const res = await request(server)
        .get(`/api/users/${targetUsername}`)
        .set('Cookie', viewerCookies);

      expect(res.status).toBe(200);
      expect(res.body.viewerState.isFollowing).toBe(true);

      // sanity: viewer's own profile should not show isFollowing for themselves
      const selfRes = await request(server)
        .get(`/api/users/${viewerUsername}`)
        .set('Cookie', viewerCookies);
      expect(selfRes.body.viewerState.isFollowing).toBe(false);
    });
  });

  describe('POST /api/users/:username/follow', () => {
    it('should return { following: true } after following', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies } = await registerUser();

      const res = await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      expect(res.status).toBeLessThan(300);
      expect(res.body.following).toBe(true);
    });

    it('should increment followersCount after follow', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies } = await registerUser();

      const beforeRes = await request(server).get(
        `/api/users/${targetUsername}`,
      );
      const beforeCount = beforeRes.body.stats.followersCount;

      await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      // Flush cache so stats are re-fetched from DB
      await flushTestRedis();

      const afterRes = await request(server).get(
        `/api/users/${targetUsername}`,
      );
      expect(afterRes.body.stats.followersCount).toBe(beforeCount + 1);
    });

    it('should require authentication', async () => {
      const { username } = await registerUser();

      const res = await request(server)
        .post(`/api/users/${username}/follow`)
        .set('Origin', 'http://localhost:3000');

      expect(res.status).toBe(401);
    });

    it('should return 400 when trying to follow yourself', async () => {
      const { username, cookies } = await registerUser();

      const res = await request(server)
        .post(`/api/users/${username}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      expect(res.status).toBe(400);
    });

    it('should return 404 when the target user does not exist', async () => {
      const { cookies } = await registerUser();

      const res = await request(server)
        .post('/api/users/ghostuser999/follow')
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      expect(res.status).toBe(404);
    });

    it('should be idempotent (following twice does not error)', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies } = await registerUser();

      const first = await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);
      expect(first.status).toBeLessThan(300);

      const second = await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);
      expect(second.status).toBeLessThan(300);
      expect(second.body.following).toBe(true);
    });
  });

  describe('DELETE /api/users/:username/follow', () => {
    it('should return { following: false } after unfollowing', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies } = await registerUser();

      await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      const res = await request(server)
        .delete(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      expect(res.status).toBeLessThan(300);
      expect(res.body.following).toBe(false);
    });

    it('should decrement followersCount after unfollow', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies } = await registerUser();

      await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      // Flush cache so follow is visible
      await flushTestRedis();

      const afterFollowRes = await request(server).get(
        `/api/users/${targetUsername}`,
      );
      const countAfterFollow = afterFollowRes.body.stats.followersCount;

      await request(server)
        .delete(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      await flushTestRedis();

      const afterUnfollowRes = await request(server).get(
        `/api/users/${targetUsername}`,
      );
      expect(afterUnfollowRes.body.stats.followersCount).toBe(
        countAfterFollow - 1,
      );
    });

    it('should require authentication', async () => {
      const { username } = await registerUser();

      const res = await request(server)
        .delete(`/api/users/${username}/follow`)
        .set('Origin', 'http://localhost:3000');

      expect(res.status).toBe(401);
    });

    it('should return 400 when trying to unfollow yourself', async () => {
      const { username, cookies } = await registerUser();

      const res = await request(server)
        .delete(`/api/users/${username}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      expect(res.status).toBe(400);
    });

    it('should be idempotent (unfollowing when not following does not error)', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies } = await registerUser();

      const res = await request(server)
        .delete(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      expect(res.status).toBeLessThan(300);
      expect(res.body.following).toBe(false);
    });
  });

  describe('Follow/Unfollow flow', () => {
    it('should reflect follow then unfollow in viewerState and stats', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies } = await registerUser();

      // Initially not following
      await flushTestRedis();
      const initial = await request(server)
        .get(`/api/users/${targetUsername}`)
        .set('Cookie', cookies);
      expect(initial.body.viewerState.isFollowing).toBe(false);
      const initialFollowers = initial.body.stats.followersCount;

      // Follow
      await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);
      await flushTestRedis();

      const afterFollow = await request(server)
        .get(`/api/users/${targetUsername}`)
        .set('Cookie', cookies);
      expect(afterFollow.body.viewerState.isFollowing).toBe(true);
      expect(afterFollow.body.stats.followersCount).toBe(initialFollowers + 1);

      // Unfollow
      await request(server)
        .delete(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);
      await flushTestRedis();

      const afterUnfollow = await request(server)
        .get(`/api/users/${targetUsername}`)
        .set('Cookie', cookies);
      expect(afterUnfollow.body.viewerState.isFollowing).toBe(false);
      expect(afterUnfollow.body.stats.followersCount).toBe(initialFollowers);
    });
  });

  describe('GET /api/users/:username/followers', () => {
    it('should return an empty list when no one follows the user', async () => {
      const { username } = await registerUser();

      const res = await request(server).get(`/api/users/${username}/followers`);

      expect(res.status).toBe(200);
      expect(res.body.users).toBeDefined();
      expect(Array.isArray(res.body.users)).toBe(true);
      expect(res.body.users).toHaveLength(0);
    });

    it('should list followers after a follow', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies, username: followerUsername } = await registerUser();

      await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      const res = await request(server).get(
        `/api/users/${targetUsername}/followers`,
      );

      expect(res.status).toBe(200);
      expect(res.body.users).toHaveLength(1);
      expect(res.body.users[0].username).toBe(followerUsername);
    });

    it('should remove follower from list after unfollow', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies } = await registerUser();

      await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      await request(server)
        .delete(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      const res = await request(server).get(
        `/api/users/${targetUsername}/followers`,
      );

      expect(res.status).toBe(200);
      expect(res.body.users).toHaveLength(0);
    });

    it('should return 404 for a non-existent user', async () => {
      const res = await request(server).get(
        '/api/users/ghostuser999/followers',
      );

      expect(res.status).toBe(404);
    });

    it('should include expected fields on follower objects', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies } = await registerUser();

      await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      const res = await request(server).get(
        `/api/users/${targetUsername}/followers`,
      );

      expect(res.status).toBe(200);
      const follower = res.body.users[0];
      expect(follower).toHaveProperty('id');
      expect(follower).toHaveProperty('username');
      expect(follower).toHaveProperty('verified');
      expect(follower).toHaveProperty('reputation');
      expect(follower).not.toHaveProperty('passwordHash');
      expect(follower).not.toHaveProperty('email');
    });
  });

  describe('GET /api/users/:username/following', () => {
    it('should return an empty list when the user follows no one', async () => {
      const { username } = await registerUser();

      const res = await request(server).get(`/api/users/${username}/following`);

      expect(res.status).toBe(200);
      expect(res.body.users).toBeDefined();
      expect(Array.isArray(res.body.users)).toBe(true);
      expect(res.body.users).toHaveLength(0);
    });

    it('should list the user the follower is following', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies, username: followerUsername } = await registerUser();

      await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      const res = await request(server).get(
        `/api/users/${followerUsername}/following`,
      );

      expect(res.status).toBe(200);
      expect(res.body.users).toHaveLength(1);
      expect(res.body.users[0].username).toBe(targetUsername);
    });

    it('should return 404 for a non-existent user', async () => {
      const res = await request(server).get(
        '/api/users/ghostuser999/following',
      );

      expect(res.status).toBe(404);
    });

    it('should include expected fields on following objects', async () => {
      const { username: targetUsername } = await registerUser();
      const { cookies, username: followerUsername } = await registerUser();

      await request(server)
        .post(`/api/users/${targetUsername}/follow`)
        .set('Origin', 'http://localhost:3000')
        .set('Cookie', cookies);

      const res = await request(server).get(
        `/api/users/${followerUsername}/following`,
      );

      expect(res.status).toBe(200);
      const followed = res.body.users[0];
      expect(followed).toHaveProperty('id');
      expect(followed).toHaveProperty('username');
      expect(followed).toHaveProperty('verified');
      expect(followed).toHaveProperty('reputation');
      expect(followed).not.toHaveProperty('passwordHash');
      expect(followed).not.toHaveProperty('email');
    });
  });
});
