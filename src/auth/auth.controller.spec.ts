import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { NotificationsService } from '../notifications/notifications.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: Record<string, jest.Mock>;
  let notificationsService: Record<string, jest.Mock>;
  let mockRes: any;
  let mockReq: any;

  beforeEach(() => {
    mockReq = {
      headers: { 'user-agent': 'TestBrowser/1.0' },
      cookies: {},
      socket: { remoteAddress: '203.0.113.50' },
    };
    authService = {
      getSessionTokenFromRequest: jest.fn(),
      getSessionFromToken: jest.fn(),
      findUserByEmailOrUsername: jest.fn(),
      findUserByEmail: jest.fn(),
      hashPassword: jest.fn(),
      comparePassword: jest.fn(),
      createUser: jest.fn(),
      createSession: jest.fn(),
      deleteSession: jest.fn(),
      deleteOtherSessions: jest.fn(),
      getUserById: jest.fn(),
      updatePassword: jest.fn(),
      updateProfile: jest.fn(),
      isUsernameAvailable: jest.fn(),
      generateUsernameSuggestions: jest.fn(),
    };
    notificationsService = {
      createForUser: jest.fn().mockResolvedValue(undefined),
    };
    controller = new AuthController(
      authService as unknown as AuthService,
      notificationsService as unknown as NotificationsService,
    );
    mockRes = {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };
  });

  describe('register', () => {
    it('should create user + session and set cookie', async () => {
      const user = {
        id: 'u1',
        email: 'test@test.com',
        username: 'testuser',
        role: 'USER',
        avatar: null,
        verified: false,
        reputation: 0,
      };
      authService.findUserByEmailOrUsername.mockResolvedValue(null);
      authService.hashPassword.mockResolvedValue('hashed');
      authService.createUser.mockResolvedValue(user);
      authService.createSession.mockResolvedValue('jwt-token');

      const result = await controller.register(
        {
          email: 'test@test.com',
          username: 'testuser',
          password: 'password123',
        },
        mockReq,
        mockRes,
      );

      expect(result.user).toEqual(user);
      expect(result.message).toBe('Registration successful');
      expect(mockRes.cookie).toHaveBeenCalledWith(
        'session',
        'jwt-token',
        expect.objectContaining({ httpOnly: true }),
      );
    });

    it('should reject duplicate email', async () => {
      authService.findUserByEmailOrUsername.mockResolvedValue({
        id: 'existing',
        email: 'test@test.com',
        username: 'other',
      });

      await expect(
        controller.register(
          {
            email: 'test@test.com',
            username: 'newuser',
            password: 'password123',
          },
          mockReq,
          mockRes,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject duplicate username', async () => {
      authService.findUserByEmailOrUsername.mockResolvedValue({
        id: 'existing',
        email: 'other@test.com',
        username: 'testuser',
      });

      await expect(
        controller.register(
          {
            email: 'new@test.com',
            username: 'testuser',
            password: 'password123',
          },
          mockReq,
          mockRes,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject short password via Zod validation', async () => {
      await expect(
        controller.register(
          { email: 'test@test.com', username: 'testuser', password: 'short' },
          mockReq,
          mockRes,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid email via Zod validation', async () => {
      await expect(
        controller.register(
          {
            email: 'not-an-email',
            username: 'testuser',
            password: 'password123',
          },
          mockReq,
          mockRes,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject username shorter than 3 chars', async () => {
      await expect(
        controller.register(
          { email: 'test@test.com', username: 'ab', password: 'password123' },
          mockReq,
          mockRes,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should pass SessionMetadata to createSession with trigger=register', async () => {
      authService.findUserByEmailOrUsername.mockResolvedValue(null);
      authService.hashPassword.mockResolvedValue('hashed');
      authService.createUser.mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        username: 'testuser',
        role: 'USER',
        avatar: null,
        verified: false,
        reputation: 0,
      });
      authService.createSession.mockResolvedValue('jwt-token');

      await controller.register(
        {
          email: 'test@test.com',
          username: 'testuser',
          password: 'password123',
        },
        mockReq,
        mockRes,
      );

      expect(authService.createSession).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({
          ip: '203.0.113.50',
          userAgent: 'TestBrowser/1.0',
          trigger: 'register',
        }),
      );
    });

    it('should pass registrationIp and registrationCountry to createUser', async () => {
      const reqWithCountry = {
        ...mockReq,
        headers: {
          ...mockReq.headers,
          'cf-ipcountry': 'US',
        },
      };
      authService.findUserByEmailOrUsername.mockResolvedValue(null);
      authService.hashPassword.mockResolvedValue('hashed');
      authService.createUser.mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        username: 'testuser',
        role: 'USER',
        avatar: null,
        verified: false,
        reputation: 0,
      });
      authService.createSession.mockResolvedValue('jwt-token');

      await controller.register(
        {
          email: 'test@test.com',
          username: 'testuser',
          password: 'password123',
        },
        reqWithCountry,
        mockRes,
      );

      expect(authService.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          registrationIp: '203.0.113.50',
          registrationCountry: 'US',
        }),
      );
    });

    it('should have rate limiting metadata (5/60s)', () => {
      const register = AuthController.prototype.register;
      expect(Reflect.getMetadata('THROTTLER:LIMITshort', register)).toBe(5);
      expect(Reflect.getMetadata('THROTTLER:TTLshort', register)).toBe(60_000);
    });
  });

  describe('login', () => {
    it('should validate credentials and set cookie', async () => {
      const user = {
        id: 'u1',
        email: 'test@test.com',
        username: 'testuser',
        role: 'USER',
        avatar: null,
        verified: false,
        reputation: 0,
        passwordHash: 'hashed',
      };
      authService.findUserByEmail.mockResolvedValue(user);
      authService.comparePassword.mockResolvedValue(true);
      authService.createSession.mockResolvedValue('jwt-token');

      const result = await controller.login(
        { email: 'test@test.com', password: 'password123' },
        mockReq,
        mockRes,
      );

      expect(result.user.id).toBe('u1');
      expect(result.message).toBe('Login successful');
      expect(mockRes.cookie).toHaveBeenCalledWith(
        'session',
        'jwt-token',
        expect.objectContaining({ httpOnly: true }),
      );
    });

    it('should reject wrong password (no enumeration)', async () => {
      authService.findUserByEmail.mockResolvedValue({
        id: 'u1',
        passwordHash: 'hashed',
      });
      authService.comparePassword.mockResolvedValue(false);

      await expect(
        controller.login(
          { email: 'test@test.com', password: 'wrong' },
          mockReq,
          mockRes,
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject non-existent user (same message as wrong password)', async () => {
      authService.findUserByEmail.mockResolvedValue(null);

      const err = controller.login(
        { email: 'noone@test.com', password: 'password123' },
        mockReq,
        mockRes,
      );

      await expect(err).rejects.toThrow('Invalid email or password');
    });

    it('should pass SessionMetadata to createSession with trigger=login', async () => {
      authService.findUserByEmail.mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        username: 'testuser',
        role: 'USER',
        avatar: null,
        verified: false,
        reputation: 0,
        passwordHash: 'hashed',
      });
      authService.comparePassword.mockResolvedValue(true);
      authService.createSession.mockResolvedValue('jwt-token');

      await controller.login(
        { email: 'test@test.com', password: 'password123' },
        mockReq,
        mockRes,
      );

      expect(authService.createSession).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({
          ip: '203.0.113.50',
          userAgent: 'TestBrowser/1.0',
          trigger: 'login',
        }),
      );
    });

    it('should have rate limiting metadata (5/60s)', () => {
      const login = AuthController.prototype.login;
      expect(Reflect.getMetadata('THROTTLER:LIMITshort', login)).toBe(5);
      expect(Reflect.getMetadata('THROTTLER:TTLshort', login)).toBe(60_000);
    });
  });

  describe('logout', () => {
    it('should clear session from DB and cookie', async () => {
      authService.getSessionTokenFromRequest.mockReturnValue('jwt-token');
      authService.deleteSession.mockResolvedValue(undefined);

      const req = { headers: {}, cookies: { session: 'jwt-token' } } as any;
      const result = await controller.logout(req, mockRes);

      expect(authService.deleteSession).toHaveBeenCalledWith('jwt-token');
      expect(mockRes.clearCookie).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({ path: '/' }),
      );
      expect(result.message).toBe('Logout successful');
    });

    it('should handle logout when no token present', async () => {
      authService.getSessionTokenFromRequest.mockReturnValue(undefined);

      const req = { headers: {}, cookies: {} } as any;
      const result = await controller.logout(req, mockRes);

      expect(authService.deleteSession).not.toHaveBeenCalled();
      expect(result.message).toBe('Logout successful');
    });
  });

  describe('me', () => {
    it('should return user when authenticated', async () => {
      const user = { id: 'u1', username: 'testuser' };
      authService.getSessionTokenFromRequest.mockReturnValue('token');
      authService.getSessionFromToken.mockResolvedValue(user);

      const req = { headers: {}, cookies: {} } as any;
      const result = await controller.me(req);

      expect(result.user).toEqual(user);
    });

    it('should return null user when not authenticated', async () => {
      authService.getSessionTokenFromRequest.mockReturnValue(undefined);
      authService.getSessionFromToken.mockResolvedValue(null);

      const req = { headers: {}, cookies: {} } as any;
      const result = await controller.me(req);

      expect(result.user).toBeNull();
    });
  });

  describe('updateProfile (PATCH /me)', () => {
    it('should update profile', async () => {
      const updatedUser = {
        id: 'u1',
        email: 'test@test.com',
        username: 'newname',
        role: 'USER',
        avatar: null,
        bio: null,
        verified: false,
        reputation: 0,
      };
      authService.findUserByEmailOrUsername.mockResolvedValue(null);
      authService.updateProfile.mockResolvedValue(updatedUser);

      const req = {
        headers: {},
        cookies: {},
        user: { id: 'u1', username: 'oldname' },
      } as any;

      const result = await controller.updateProfile(
        { username: 'newname' },
        req,
      );

      expect(result.user).toEqual(updatedUser);
    });

    it('should reject conflicting username', async () => {
      authService.findUserByEmailOrUsername.mockResolvedValue({
        id: 'other-user',
        email: '',
        username: 'taken',
      });

      const req = {
        headers: {},
        cookies: {},
        user: { id: 'u1', username: 'oldname' },
      } as any;

      await expect(
        controller.updateProfile({ username: 'taken' }, req),
      ).rejects.toThrow(ConflictException);
    });

    it('should have AuthGuard decorator', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AuthController.prototype.updateProfile,
      );
      expect(guards).toBeDefined();
      expect(guards).toContainEqual(AuthGuard);
    });
  });

  describe('changePassword', () => {
    it('should verify old password and rotate session', async () => {
      authService.getUserById.mockResolvedValue({
        id: 'u1',
        passwordHash: 'old-hash',
      });
      authService.comparePassword.mockResolvedValue(true);
      authService.hashPassword.mockResolvedValue('new-hash');
      authService.updatePassword.mockResolvedValue(undefined);
      authService.createSession.mockResolvedValue('new-token');
      authService.deleteOtherSessions.mockResolvedValue(2);

      const req = {
        headers: {},
        cookies: {},
        user: { id: 'u1', username: 'testuser' },
      } as any;

      const result = await controller.changePassword(
        { currentPassword: 'oldpass123', newPassword: 'newpass123' },
        req,
        mockRes,
      );

      expect(result.message).toBe('Password changed successfully');
      expect(authService.updatePassword).toHaveBeenCalledWith('u1', 'new-hash');
      expect(authService.deleteOtherSessions).toHaveBeenCalledWith(
        'u1',
        'new-token',
      );
      expect(mockRes.cookie).toHaveBeenCalledWith(
        'session',
        'new-token',
        expect.any(Object),
      );
      expect(notificationsService.createForUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          type: 'MENTION',
          title: 'Password changed',
        }),
      );
    });

    it('should reject incorrect current password', async () => {
      authService.getUserById.mockResolvedValue({
        id: 'u1',
        passwordHash: 'hash',
      });
      authService.comparePassword.mockResolvedValue(false);

      const req = {
        headers: {},
        cookies: {},
        user: { id: 'u1', username: 'testuser' },
      } as any;

      await expect(
        controller.changePassword(
          { currentPassword: 'wrong', newPassword: 'newpass123' },
          req,
          mockRes,
        ),
      ).rejects.toThrow('Current password is incorrect');
    });

    it('should reject short new password via Zod', async () => {
      const req = {
        headers: {},
        cookies: {},
        user: { id: 'u1', username: 'testuser' },
      } as any;

      await expect(
        controller.changePassword(
          { currentPassword: 'oldpass123', newPassword: 'short' },
          req,
          mockRes,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should have AuthGuard decorator', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AuthController.prototype.changePassword,
      );
      expect(guards).toBeDefined();
      expect(guards).toContainEqual(AuthGuard);
    });
  });
});
