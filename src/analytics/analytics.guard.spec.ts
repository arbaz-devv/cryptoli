import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AnalyticsGuard } from './analytics.guard';

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

describe('AnalyticsGuard', () => {
  let guard: AnalyticsGuard;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    guard = new AnalyticsGuard();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should reject when ANALYTICS_API_KEY is not set (fail-closed)', () => {
    delete process.env.ANALYTICS_API_KEY;

    const req = mockRequest();
    expect(() => guard.canActivate(mockContext(req))).toThrow(
      UnauthorizedException,
    );
  });

  it('should reject when ANALYTICS_API_KEY is empty string (fail-closed)', () => {
    process.env.ANALYTICS_API_KEY = '  ';

    const req = mockRequest();
    expect(() => guard.canActivate(mockContext(req))).toThrow(
      UnauthorizedException,
    );
  });

  it('should reject wrong key', () => {
    process.env.ANALYTICS_API_KEY = 'correct-key';

    const req = mockRequest({ 'x-analytics-key': 'wrong-key' });
    expect(() => guard.canActivate(mockContext(req))).toThrow(
      UnauthorizedException,
    );
  });

  it('should accept correct key via X-Analytics-Key header', () => {
    process.env.ANALYTICS_API_KEY = 'correct-key';

    const req = mockRequest({ 'x-analytics-key': 'correct-key' });
    expect(guard.canActivate(mockContext(req))).toBe(true);
  });

  it('should reject key via query string (header only)', () => {
    process.env.ANALYTICS_API_KEY = 'correct-key';

    const req = {
      headers: {},
      query: { key: 'correct-key' },
    };
    expect(() =>
      guard.canActivate(mockContext(req as ReturnType<typeof mockRequest>)),
    ).toThrow(UnauthorizedException);
  });

  it('should reject when no header is provided', () => {
    process.env.ANALYTICS_API_KEY = 'correct-key';

    const req = mockRequest();
    expect(() => guard.canActivate(mockContext(req))).toThrow(
      UnauthorizedException,
    );
  });
});
