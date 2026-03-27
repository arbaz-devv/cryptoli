import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { AnalyticsInterceptor } from './analytics.interceptor';
import type { AnalyticsContext } from './analytics-context';

describe('AnalyticsInterceptor', () => {
  let interceptor: AnalyticsInterceptor;
  const nextHandler: CallHandler = { handle: () => of('result') };

  beforeEach(() => {
    interceptor = new AnalyticsInterceptor();
  });

  function createContext(
    headers: Record<string, string | undefined> = {},
    extra: { remoteAddress?: string; ip?: string } = {},
  ): { context: ExecutionContext; req: any } {
    const req = {
      headers,
      socket: { remoteAddress: extra.remoteAddress },
      ip: extra.ip,
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext;
    return { context, req };
  }

  it('should populate req.analyticsCtx with IP from cf-connecting-ip', (done) => {
    const { context, req } = createContext({
      'cf-connecting-ip': '203.0.113.1',
      'user-agent': 'Mozilla/5.0',
    });

    interceptor.intercept(context, nextHandler).subscribe(() => {
      const ctx: AnalyticsContext = req.analyticsCtx;
      expect(ctx.ip).toBe('203.0.113.1');
      expect(ctx.userAgent).toBe('Mozilla/5.0');
      done();
    });
  });

  it('should extract country from CDN header', (done) => {
    const { context, req } = createContext({
      'cf-connecting-ip': '8.8.8.8',
      'cf-ipcountry': 'US',
    });

    interceptor.intercept(context, nextHandler).subscribe(() => {
      expect(req.analyticsCtx.country).toBe('US');
      done();
    });
  });

  it('should set country to undefined when no country header present', (done) => {
    const { context, req } = createContext({}, { remoteAddress: '8.8.8.8' });

    interceptor.intercept(context, nextHandler).subscribe(() => {
      expect(req.analyticsCtx.country).toBeUndefined();
      done();
    });
  });

  it('should fall back to socket remoteAddress for IP', (done) => {
    const { context, req } = createContext(
      { 'user-agent': 'TestAgent' },
      { remoteAddress: '203.0.113.5' },
    );

    interceptor.intercept(context, nextHandler).subscribe(() => {
      expect(req.analyticsCtx.ip).toBe('203.0.113.5');
      done();
    });
  });

  it('should use empty string when user-agent header is absent', (done) => {
    const { context, req } = createContext({}, { remoteAddress: '8.8.8.8' });

    interceptor.intercept(context, nextHandler).subscribe(() => {
      expect(req.analyticsCtx.userAgent).toBe('');
      done();
    });
  });

  it('should call next.handle() and pass through the result', (done) => {
    const { context } = createContext({}, { remoteAddress: '8.8.8.8' });

    interceptor.intercept(context, nextHandler).subscribe((result) => {
      expect(result).toBe('result');
      done();
    });
  });
});
