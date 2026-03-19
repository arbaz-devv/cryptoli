import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class AnalyticsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const envKey = process.env.ANALYTICS_API_KEY || '';

    // Fail closed: if no key is configured, reject all requests
    if (!envKey.trim()) {
      throw new UnauthorizedException('Analytics API key is not configured');
    }

    const headerKey =
      typeof req.headers?.['x-analytics-key'] === 'string'
        ? req.headers['x-analytics-key']
        : Array.isArray(req.headers?.['x-analytics-key'])
          ? req.headers['x-analytics-key'][0]
          : undefined;

    if (headerKey === envKey) return true;

    throw new UnauthorizedException(
      'Valid Analytics API key required via X-Analytics-Key header',
    );
  }
}
