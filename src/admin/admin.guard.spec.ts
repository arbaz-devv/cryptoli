import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AdminGuard, ADMIN_JWT_TYPE } from './admin.guard';
import { ConfigService } from '../config/config.service';

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

function mockRequest(headers: Record<string, string> = {}): {
  headers: Record<string, string>;
} {
  return { headers };
}

function mockContext(req: ReturnType<typeof mockRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  let guard: AdminGuard;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    const config = { jwtSecret: JWT_SECRET } as ConfigService;
    guard = new AdminGuard(config);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('API key auth', () => {
    it('should reject ANALYTICS_API_KEY — only ADMIN_API_KEY is accepted', () => {
      process.env.ANALYTICS_API_KEY = 'analytics-key-123';
      delete process.env.ADMIN_API_KEY;

      const req = mockRequest({ 'x-admin-key': 'analytics-key-123' });
      expect(() => guard.canActivate(mockContext(req))).toThrow(
        UnauthorizedException,
      );
    });

    it('should accept ADMIN_API_KEY via X-Admin-Key header', () => {
      process.env.ADMIN_API_KEY = 'admin-key-456';

      const req = mockRequest({ 'x-admin-key': 'admin-key-456' });
      expect(guard.canActivate(mockContext(req))).toBe(true);
    });

    it('should reject query string key parameter', () => {
      process.env.ADMIN_API_KEY = 'admin-key-456';

      const req = {
        headers: {},
        query: { key: 'admin-key-456' },
      };
      expect(() =>
        guard.canActivate(mockContext(req as ReturnType<typeof mockRequest>)),
      ).toThrow(UnauthorizedException);
    });

    it('should reject wrong key', () => {
      process.env.ADMIN_API_KEY = 'admin-key-456';

      const req = mockRequest({ 'x-admin-key': 'wrong-key' });
      expect(() => guard.canActivate(mockContext(req))).toThrow(
        UnauthorizedException,
      );
    });

    it('should reject when ADMIN_API_KEY is undefined', () => {
      delete process.env.ADMIN_API_KEY;

      const req = mockRequest({ 'x-admin-key': 'any-key' });
      expect(() => guard.canActivate(mockContext(req))).toThrow(
        UnauthorizedException,
      );
    });

    it('should reject when ADMIN_API_KEY is whitespace-only', () => {
      process.env.ADMIN_API_KEY = '   ';

      const req = mockRequest({ 'x-admin-key': '   ' });
      expect(() => guard.canActivate(mockContext(req))).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('JWT-based admin auth', () => {
    it('should accept valid admin JWT', () => {
      delete process.env.ADMIN_API_KEY;
      const token = jwt.sign(
        { type: ADMIN_JWT_TYPE, email: 'admin@test.com', sub: 'admin@test.com' },
        JWT_SECRET,
        { expiresIn: '24h' },
      );

      const req = mockRequest({ authorization: `Bearer ${token}` });
      expect(guard.canActivate(mockContext(req))).toBe(true);
    });

    it('should reject non-admin JWT (type is not admin)', () => {
      delete process.env.ADMIN_API_KEY;
      const token = jwt.sign(
        { type: 'user', userId: 'u1' },
        JWT_SECRET,
        { expiresIn: '1h' },
      );

      const req = mockRequest({ authorization: `Bearer ${token}` });
      expect(() => guard.canActivate(mockContext(req))).toThrow(
        UnauthorizedException,
      );
    });

    it('should reject expired admin JWT', () => {
      delete process.env.ADMIN_API_KEY;
      const token = jwt.sign(
        { type: ADMIN_JWT_TYPE, email: 'admin@test.com' },
        JWT_SECRET,
        { expiresIn: '-1s' },
      );

      const req = mockRequest({ authorization: `Bearer ${token}` });
      expect(() => guard.canActivate(mockContext(req))).toThrow(
        UnauthorizedException,
      );
    });

    it('should reject JWT signed with wrong secret', () => {
      delete process.env.ADMIN_API_KEY;
      const token = jwt.sign(
        { type: ADMIN_JWT_TYPE, email: 'admin@test.com' },
        'wrong-secret',
        { expiresIn: '24h' },
      );

      const req = mockRequest({ authorization: `Bearer ${token}` });
      expect(() => guard.canActivate(mockContext(req))).toThrow(
        UnauthorizedException,
      );
    });

    it('should reject malformed authorization header', () => {
      delete process.env.ADMIN_API_KEY;

      const req = mockRequest({ authorization: 'NotBearer token' });
      expect(() => guard.canActivate(mockContext(req))).toThrow(
        UnauthorizedException,
      );
    });
  });
});
