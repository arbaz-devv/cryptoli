import { UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';
import { AdminAuthService } from './admin-auth.service';
import { ConfigService } from '../config/config.service';
import { ADMIN_JWT_TYPE } from './admin.guard';

describe('AdminAuthService', () => {
  const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
  const ADMIN_EMAIL = 'admin@test.com';
  const ADMIN_PASSWORD = 'testpassword';
  let adminPasswordHash: string;
  let service: AdminAuthService;

  beforeAll(async () => {
    adminPasswordHash = await bcrypt.hash(ADMIN_PASSWORD, 1);
  });

  function createService(overrides: Partial<ConfigService> = {}) {
    const config = {
      jwtSecret: JWT_SECRET,
      adminEmail: ADMIN_EMAIL,
      adminPasswordHash,
      ...overrides,
    } as ConfigService;
    return new AdminAuthService(config);
  }

  beforeEach(() => {
    service = createService();
  });

  describe('isLoginEnabled', () => {
    it('should return true when both email and hash are configured', () => {
      expect(service.isLoginEnabled()).toBe(true);
    });

    it('should return false when email is missing', () => {
      service = createService({ adminEmail: undefined });
      expect(service.isLoginEnabled()).toBe(false);
    });

    it('should return false when email is empty/whitespace', () => {
      service = createService({ adminEmail: '   ' });
      expect(service.isLoginEnabled()).toBe(false);
    });

    it('should return false when hash is missing', () => {
      service = createService({ adminPasswordHash: undefined });
      expect(service.isLoginEnabled()).toBe(false);
    });

    it('should return false when hash is empty/whitespace', () => {
      service = createService({ adminPasswordHash: '  ' });
      expect(service.isLoginEnabled()).toBe(false);
    });
  });

  describe('login', () => {
    it('should return JWT with admin type claim and 24h expiry', async () => {
      const result = await service.login(ADMIN_EMAIL, ADMIN_PASSWORD);

      expect(result.token).toBeDefined();
      expect(result.expiresIn).toBe(86400); // 24h in seconds

      const payload = jwt.verify(result.token, JWT_SECRET) as any;
      expect(payload.type).toBe(ADMIN_JWT_TYPE);
      expect(payload.email).toBe(ADMIN_EMAIL);
      expect(payload.sub).toBe(ADMIN_EMAIL);
    });

    it('should throw UnauthorizedException for wrong email', async () => {
      await expect(
        service.login('wrong@test.com', ADMIN_PASSWORD),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.login('wrong@test.com', ADMIN_PASSWORD),
      ).rejects.toThrow('Invalid credentials');
    });

    it('should throw UnauthorizedException for wrong password', async () => {
      await expect(
        service.login(ADMIN_EMAIL, 'wrongpassword'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when login not configured', async () => {
      service = createService({ adminEmail: undefined });

      await expect(
        service.login(ADMIN_EMAIL, ADMIN_PASSWORD),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.login(ADMIN_EMAIL, ADMIN_PASSWORD),
      ).rejects.toThrow('Admin login is not configured');
    });

    it('should be case-insensitive for email comparison', async () => {
      const result = await service.login(
        ADMIN_EMAIL.toUpperCase(),
        ADMIN_PASSWORD,
      );
      expect(result.token).toBeDefined();
    });
  });
});
