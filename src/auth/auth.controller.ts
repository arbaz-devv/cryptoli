import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { CookieOptions } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ZodError } from 'zod';
import { AuthService } from './auth.service';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from '../common/utils';
import { AuthGuard } from './auth.guard';
import { NotificationsService } from '../notifications/notifications.service';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly notificationsService: NotificationsService,
  ) {}

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

  @Patch('me')
  @UseGuards(AuthGuard)
  async updateProfile(
    @Body() body: unknown,
    @Req() req: Request & { user: { id: string; username: string } },
  ) {
    let parsed: { name?: string; username?: string; bio?: string };
    try {
      const raw =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : {};
      parsed = updateProfileSchema.parse({
        name: raw.name,
        username: raw.username,
        bio: raw.bio,
      }) as { name?: string; username?: string; bio?: string };
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

    const data: { name?: string; username?: string; bio?: string } = {};
    if (parsed.name !== undefined) data.name = parsed.name.trim();
    if (parsed.username !== undefined) data.username = parsed.username.trim();
    if (parsed.bio !== undefined) data.bio = parsed.bio.trim();

    if (Object.keys(data).length === 0) {
      const token = this.authService.getSessionTokenFromRequest(req);
      const user = await this.authService.getSessionFromToken(token);
      return { user };
    }

    const user = await this.authService.updateProfile(req.user.id, data);
    return { user };
  }

  @Throttle({
    short: { limit: 5, ttl: 60_000 },
    long: { limit: 5, ttl: 60_000 },
  })
  @Post('register')
  async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    let parsed: {
      email: string;
      username: string;
      password: string;
      name?: string;
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
        name: raw.name,
      }) as {
        email: string;
        username: string;
        password: string;
        name?: string;
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
    const name = parsed.name?.trim() || null;

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
    const user = await this.authService.createUser({
      email,
      username,
      passwordHash,
      ...(name ? { name } : {}),
    });

    const token = await this.authService.createSession(user.id);
    res.cookie('session', token, this.sessionCookieOptions());

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

    const token = await this.authService.createSession(user.id);
    res.cookie('session', token, this.sessionCookieOptions());

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        name: user.name ?? null,
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
    return { message: 'Logout successful' };
  }

  @Post('change-password')
  @UseGuards(AuthGuard)
  async changePassword(
    @Body() body: unknown,
    @Req() req: Request & {
      user: {
        id: string;
        username: string;
      };
    },
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

    await this.notificationsService.createForUser({
      userId: req.user.id,
      type: 'MENTION',
      title: 'Password changed',
      message: 'Your account password was updated successfully.',
      link: `/${req.user.username}`,
    });

    return { message: 'Password changed successfully' };
  }
}
