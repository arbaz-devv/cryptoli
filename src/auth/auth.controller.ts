import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Optional,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { CookieOptions } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AuthService, SessionMetadata } from './auth.service';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from '../common/utils';
import { AuthGuard } from './auth.guard';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsInterceptor } from '../analytics/analytics.interceptor';
import { getAnalyticsCtx } from '../analytics/analytics-context';
import { AnalyticsService } from '../analytics/analytics.service';
import { getClientIp, getCountryHint } from '../analytics/ip-utils';

@UseInterceptors(AnalyticsInterceptor)
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly notificationsService: NotificationsService,
    @Optional()
    @Inject(AnalyticsService)
    private readonly analyticsService?: AnalyticsService,
  ) {}

  private extractSessionMeta(
    req: Request,
    trigger: SessionMetadata['trigger'],
  ): SessionMetadata {
    return {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      country: getCountryHint(req) || undefined,
      trigger,
    };
  }

  private trackAuthEvent(
    req: Request,
    event: 'user_login' | 'user_register' | 'user_logout' | 'password_change',
    userId?: string,
    properties?: Record<string, unknown>,
  ): void {
    if (!this.analyticsService) return;
    const ctx = getAnalyticsCtx(req);
    if (!ctx) return;
    void this.analyticsService.track(
      ctx.ip,
      ctx.userAgent,
      {
        event,
        consent: true,
        userId,
        properties,
      },
      ctx.country,
    );
  }

  private sessionCookieOptions(): CookieOptions {
    const corsOrigin = process.env.CORS_ORIGIN ?? '';
    const isLocalDevOrigin =
      corsOrigin.includes('http://localhost') ||
      corsOrigin.includes('http://127.0.0.1');
    const isProduction = process.env.NODE_ENV === 'production';
    // Cross-origin (e.g. Vercel → Railway): browser only sends cookie if SameSite=None; Secure
    const sameSite: 'lax' | 'none' =
      isProduction && !isLocalDevOrigin ? 'none' : 'lax';
    return {
      httpOnly: true,
      sameSite,
      secure: isProduction && !isLocalDevOrigin ? true : isProduction,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const token = this.authService.getSessionTokenFromRequest(req);
    const user = await this.authService.getSessionFromToken(token);
    return { user };
  }

  @Get('check-username')
  async checkUsername(
    @Query('username') username: string | undefined,
    @Req() req: Request,
  ) {
    const raw = (username ?? '').trim();
    if (raw.length < 3 || raw.length > 30) {
      throw new BadRequestException('Username must be 3–30 characters');
    }
    if (!/^[a-zA-Z0-9_]+$/.test(raw)) {
      throw new BadRequestException(
        'Username can only contain letters, numbers, and underscores',
      );
    }
    const token = this.authService.getSessionTokenFromRequest(req);
    const currentUser = await this.authService.getSessionFromToken(token);
    const available = await this.authService.isUsernameAvailable(
      raw,
      currentUser?.id,
    );
    return { available };
  }

  @Get('username-suggestions')
  async usernameSuggestions(
    @Query('base') base: string | undefined,
    @Req() req: Request,
  ) {
    const token = this.authService.getSessionTokenFromRequest(req);
    const currentUser = await this.authService.getSessionFromToken(token);
    const suggestions = await this.authService.generateUsernameSuggestions(
      base ?? '',
      currentUser?.id,
    );
    return { suggestions };
  }

  @Patch('me')
  @UseGuards(AuthGuard)
  async updateProfile(
    @Body() body: unknown,
    @Req() req: Request & { user: { id: string; username: string } },
  ) {
    let parsed: { username?: string; bio?: string };
    try {
      const raw =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : {};
      parsed = updateProfileSchema.parse({
        username: raw.username,
        bio: raw.bio,
      }) as { username?: string; bio?: string };
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        throw new BadRequestException(first?.message ?? 'Validation failed');
      }
      throw err;
    }

    if (parsed.username !== undefined) {
      const username = parsed.username.trim();
      const existing = await this.authService.findUserByEmailOrUsername(
        '',
        username,
      );
      if (existing && existing.id !== req.user.id) {
        throw new ConflictException('Username is already taken');
      }
    }

    const data: { username?: string; bio?: string } = {};
    if (parsed.username !== undefined) data.username = parsed.username.trim();
    if (parsed.bio !== undefined) data.bio = parsed.bio.trim();

    if (Object.keys(data).length === 0) {
      const token = this.authService.getSessionTokenFromRequest(req);
      const user = await this.authService.getSessionFromToken(token);
      return { user };
    }

    try {
      const user = await this.authService.updateProfile(req.user.id, data);
      return { user };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = (err.meta?.target as string[] | undefined)?.[0];
        if (target === 'username') {
          throw new ConflictException('Username is already taken');
        }
      }
      throw err;
    }
  }

  @Throttle({
    short: { limit: 5, ttl: 60_000 },
    long: { limit: 5, ttl: 60_000 },
  })
  @Post('register')
  async register(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    let parsed: {
      email: string;
      username: string;
      password: string;
    };
    try {
      const raw =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : {};
      parsed = registerSchema.parse({
        email: raw.email ?? '',
        username: raw.username ?? '',
        password: raw.password ?? '',
      }) as {
        email: string;
        username: string;
        password: string;
      };
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        throw new BadRequestException(first?.message ?? 'Validation failed');
      }
      throw err;
    }

    const email = parsed.email.trim().toLowerCase();
    const username = parsed.username.trim();
    const password = parsed.password;

    const existing = await this.authService.findUserByEmailOrUsername(
      email,
      username,
    );

    if (existing?.email === email) {
      throw new ConflictException('Email is already registered');
    }
    if (existing?.username === username) {
      throw new ConflictException('Username is already taken');
    }

    const passwordHash = await this.authService.hashPassword(password);
    const meta = this.extractSessionMeta(req, 'register');
    let user: Awaited<ReturnType<AuthService['createUser']>>;
    try {
      user = await this.authService.createUser({
        email,
        username,
        passwordHash,
        registrationIp: meta.ip || undefined,
        registrationCountry: meta.country,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = (err.meta?.target as string[] | undefined)?.[0];
        if (target === 'email') {
          throw new ConflictException('Email is already registered');
        }
        if (target === 'username') {
          throw new ConflictException('Username is already taken');
        }
      }
      throw err;
    }

    const token = await this.authService.createSession(user.id, meta);
    res.cookie('session', token, this.sessionCookieOptions());

    this.trackAuthEvent(req, 'user_register', user.id, {
      username: user.username,
    });

    return {
      user,
      message: 'Registration successful',
    };
  }

  @Throttle({
    short: { limit: 5, ttl: 60_000 },
    long: { limit: 5, ttl: 60_000 },
  })
  @Post('login')
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    let parsed: { email: string; password: string };
    try {
      const raw =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : {};
      parsed = loginSchema.parse({
        email: raw.email ?? '',
        password: raw.password ?? '',
      }) as {
        email: string;
        password: string;
      };
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        throw new BadRequestException(first?.message ?? 'Validation failed');
      }
      throw err;
    }

    const email = parsed.email.trim().toLowerCase();
    const password = parsed.password;

    const user = await this.authService.findUserByEmail(email);

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await this.authService.comparePassword(
      password,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const meta = this.extractSessionMeta(req, 'login');
    const token = await this.authService.createSession(user.id, meta);
    res.cookie('session', token, this.sessionCookieOptions());

    this.trackAuthEvent(req, 'user_login', user.id, {
      username: user.username,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        avatar: user.avatar ?? null,
        verified: user.verified,
        reputation: user.reputation,
      },
      message: 'Login successful',
    };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.authService.getSessionTokenFromRequest(req);
    if (token) {
      await this.authService.deleteSession(token);
    }
    const opts = this.sessionCookieOptions();
    res.clearCookie('session', {
      path: '/',
      httpOnly: opts.httpOnly,
      sameSite: opts.sameSite,
      secure: opts.secure,
    });

    this.trackAuthEvent(req, 'user_logout');

    return { message: 'Logout successful' };
  }

  @Post('change-password')
  @UseGuards(AuthGuard)
  async changePassword(
    @Body() body: unknown,
    @Req()
    req: Request & {
      user: {
        id: string;
        username: string;
      };
    },
    @Res({ passthrough: true }) res: Response,
  ) {
    let parsed: { currentPassword: string; newPassword: string };
    try {
      const raw =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : {};
      parsed = changePasswordSchema.parse({
        currentPassword: raw.currentPassword ?? '',
        newPassword: raw.newPassword ?? '',
      });
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        throw new BadRequestException(first?.message ?? 'Validation failed');
      }
      throw err;
    }

    const user = await this.authService.getUserById(req.user.id);
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const isCurrentPasswordValid = await this.authService.comparePassword(
      parsed.currentPassword,
      user.passwordHash,
    );
    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const nextPasswordHash = await this.authService.hashPassword(
      parsed.newPassword,
    );
    await this.authService.updatePassword(req.user.id, nextPasswordHash);

    const changeMeta = this.extractSessionMeta(req, 'password_change');
    const newToken = await this.authService.createSession(
      req.user.id,
      changeMeta,
    );
    await this.authService.deleteOtherSessions(req.user.id, newToken);
    res.cookie('session', newToken, this.sessionCookieOptions());

    await this.notificationsService.createForUser({
      userId: req.user.id,
      type: 'MENTION',
      title: 'Password changed',
      message: 'Your account password was updated successfully.',
      link: `/${req.user.username}`,
    });

    this.trackAuthEvent(req, 'password_change', req.user.id);

    return { message: 'Password changed successfully' };
  }
}
