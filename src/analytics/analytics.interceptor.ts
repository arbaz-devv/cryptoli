import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { getClientIp, getCountryHint } from './ip-utils';
import type { AnalyticsContext } from './analytics-context';

/**
 * Per-controller interceptor that populates `req.analyticsCtx` with
 * IP, user-agent, and country hint extracted from request headers.
 *
 * Controllers opt in via `@UseInterceptors(AnalyticsInterceptor)`.
 * Not global — only applied to controllers that emit server-side events.
 */
@Injectable()
export class AnalyticsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<Request>();

    const analyticsCtx: AnalyticsContext = {
      ip: getClientIp(req),
      userAgent: (req.headers['user-agent'] as string) ?? '',
      country: getCountryHint(req),
    };

    (req as any).analyticsCtx = analyticsCtx;

    return next.handle();
  }
}
