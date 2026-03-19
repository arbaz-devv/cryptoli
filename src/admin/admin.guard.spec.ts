import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { ConfigService } from '../config/config.service';

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
    const config = { jwtSecret: 'test-secret' } as ConfigService;
    guard = new AdminGuard(config);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

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
});
