import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '../config/config.service';

export const ADMIN_JWT_TYPE = 'admin';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  private getApiKey(req: Request): string | null {
    const envKey = process.env.ADMIN_API_KEY || '';
    if (!envKey.trim()) return null;
    const headerKey =
      typeof req.headers?.['x-admin-key'] === 'string'
        ? req.headers['x-admin-key']
        : Array.isArray(req.headers?.['x-admin-key'])
          ? req.headers['x-admin-key'][0]
          : undefined;
    return headerKey === envKey ? envKey : null;
  }

  private getAdminFromToken(req: Request): { email: string } | null {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string') return null;
    const [scheme, token] = authHeader.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token?.trim()) return null;
    try {
      const payload = jwt.verify(token, this.config.jwtSecret) as {
        sub?: string;
        type?: string;
        email?: string;
      };
      if (payload?.type !== ADMIN_JWT_TYPE) return null;
      const email = payload.email ?? payload.sub;
      return email ? { email } : null;
    } catch {
      return null;
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (this.getApiKey(req)) return true;
    if (this.getAdminFromToken(req)) return true;
    throw new UnauthorizedException(
      'Admin API key or valid admin token required',
    );
  }
}
