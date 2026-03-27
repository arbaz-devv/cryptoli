import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';
import { GeoipService } from '../geoip/geoip.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '../config/config.service';
import { getDeviceAndBrowser } from '../common/ua';

export interface SessionMetadata {
  ip: string;
  userAgent: string;
  country?: string;
  timezone?: string;
  trigger: 'login' | 'register' | 'password_change';
}

export interface SessionUser {
  id: string;
  email: string;
  username: string;
  role: string;
  avatar: string | null;
  bio: string | null;
  verified: boolean;
  reputation: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly geoipService: GeoipService,
  ) {}

  async findUserByEmailOrUsername(email: string, username: string) {
    return this.prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
      select: { id: true, email: true, username: true },
    });
  }

  /** Check if username is available (optionally excluding current user for edit-profile). */
  async isUsernameAvailable(
    username: string,
    exceptUserId?: string,
  ): Promise<boolean> {
    const existing = await this.prisma.user.findFirst({
      where: {
        username: username.trim(),
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
      },
      select: { id: true },
    });
    return !existing;
  }

  /** Generate backend-validated username suggestions that are not already taken. */
  async generateUsernameSuggestions(
    baseRaw: string,
    exceptUserId?: string,
  ): Promise<string[]> {
    const raw = baseRaw.trim();
    if (raw.length < 3 || raw.length > 30) return [];
    if (!/^[a-zA-Z0-9_]+$/.test(raw)) return [];

    const base = raw.replace(/[^a-zA-Z0-9_]/g, '');
    if (!base) return [];

    const suggestions = new Set<string>();
    const year = new Date().getFullYear();
    const shortYear = year % 100;
    const len = base.length;

    const addCandidate = (candidate: string) => {
      const normalized = candidate.slice(0, 30);
      if (
        normalized &&
        normalized !== raw &&
        /^[a-zA-Z0-9_]+$/.test(normalized)
      ) {
        suggestions.add(normalized);
      }
    };

    // Slightly varied base forms
    addCandidate(`${base}_`);
    if (base.length > 3) {
      addCandidate(`${base.slice(0, -1)}_${base.slice(-1)}`);
    }

    // Short numeric tweaks
    addCandidate(`${base}${shortYear}`);
    addCandidate(`${base}_${shortYear}`);
    addCandidate(`${base}${(len % 10) + 1}`);
    addCandidate(`${base}_${(len % 10) + 1}`);

    // Simple domain-related suffixes/prefixes
    const adjectives = [
      'real',
      'crypto',
      'secure',
      'pro',
      'official',
      'hub',
      'reviews',
      'wallet',
    ];
    for (const word of adjectives) {
      addCandidate(`${base}_${word}`);
      addCandidate(`${word}_${base}`);
      if (suggestions.size >= 20) break;
    }

    const candidates = Array.from(suggestions).slice(0, 20);
    if (candidates.length === 0) return [];

    const existing = await this.prisma.user.findMany({
      where: {
        username: { in: candidates },
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
      },
      select: { username: true },
    });
    const takenSet = new Set(existing.map((u) => u.username));

    return candidates.filter((name) => !takenSet.has(name)).slice(0, 8);
  }

  async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        avatar: true,
        verified: true,
        reputation: true,
        passwordHash: true,
      },
    });
  }

  async createUser(input: {
    email: string;
    username: string;
    passwordHash: string;
    registrationIp?: string;
    registrationCountry?: string;
  }) {
    return this.prisma.user.create({
      data: {
        email: input.email,
        username: input.username,
        passwordHash: input.passwordHash,
        ...(input.registrationIp
          ? { registrationIp: input.registrationIp }
          : {}),
        ...(input.registrationCountry
          ? { registrationCountry: input.registrationCountry }
          : {}),
      },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        avatar: true,
        verified: true,
        reputation: true,
      },
    });
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  private parseCookieHeader(
    cookieHeader: string | undefined,
  ): Record<string, string> {
    if (!cookieHeader) return {};
    return cookieHeader.split(';').reduce(
      (acc, part) => {
        const trimmed = part.trim();
        if (!trimmed) return acc;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) return acc;
        const key = trimmed.slice(0, eqIndex).trim();
        const rawValue = trimmed.slice(eqIndex + 1);
        let value = rawValue;
        try {
          value = decodeURIComponent(rawValue);
        } catch {
          value = rawValue;
        }
        if (key) acc[key] = value;
        return acc;
      },
      {} as Record<string, string>,
    );
  }

  getSessionTokenFromRequest(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    if (typeof authHeader === 'string') {
      const [scheme, value] = authHeader.split(' ');
      if (scheme?.toLowerCase() === 'bearer' && value) {
        return value.trim();
      }
    }

    const cookieRecord = request.cookies as Record<string, unknown> | undefined;
    const tokenFromCookieParser =
      typeof cookieRecord?.session === 'string'
        ? cookieRecord.session
        : undefined;
    if (tokenFromCookieParser) return tokenFromCookieParser;
    const cookies = this.parseCookieHeader(request.headers.cookie);
    return cookies.session;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async createSession(userId: string, meta?: SessionMetadata): Promise<string> {
    const token = jwt.sign(
      { userId, jti: randomUUID() },
      this.config.jwtSecret,
      { expiresIn: '7d' },
    );

    const data: Record<string, unknown> = {
      userId,
      token: this.hashToken(token),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };

    if (meta) {
      const { device, browser, os } = getDeviceAndBrowser(meta.userAgent);
      const geoResult = meta.ip ? this.geoipService.lookup(meta.ip) : null;
      const timezone = geoResult?.timezone || meta.timezone || null;

      data.ip = meta.ip || null;
      data.ipHash = meta.ip
        ? createHash('sha256').update(meta.ip).digest('hex')
        : null;
      data.userAgent = meta.userAgent?.slice(0, 512) || null;
      data.device = device;
      data.browser = browser;
      data.os = os;
      data.country = meta.country || null;
      data.timezone = timezone;
      data.trigger = meta.trigger;
    }

    await this.prisma.session.create({
      data: data as Parameters<typeof this.prisma.session.create>[0]['data'],
    });
    return token;
  }

  async getSessionFromToken(
    token: string | undefined,
  ): Promise<SessionUser | null> {
    if (!token) return null;
    try {
      jwt.verify(token, this.config.jwtSecret);
      const session = await this.prisma.session.findUnique({
        where: { token: this.hashToken(token) },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              role: true,
              avatar: true,
              bio: true,
              verified: true,
              reputation: true,
            },
          },
        },
      });
      if (!session || session.expiresAt < new Date()) return null;
      return {
        id: session.user.id,
        email: session.user.email,
        username: session.user.username,
        role: session.user.role,
        avatar: session.user.avatar ?? null,
        bio: session.user.bio ?? null,
        verified: session.user.verified,
        reputation: session.user.reputation,
      };
    } catch {
      return null;
    }
  }

  async deleteSession(token: string): Promise<void> {
    await this.prisma.session.deleteMany({
      where: { token: this.hashToken(token) },
    });
  }

  async getUserById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
  }

  async deleteOtherSessions(
    userId: string,
    exceptToken: string,
  ): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: { userId, token: { not: this.hashToken(exceptToken) } },
    });
    return result.count;
  }

  async updateProfile(
    userId: string,
    data: { username?: string; bio?: string },
  ): Promise<SessionUser> {
    const updateData: {
      username?: string;
      bio?: string | null;
    } = {};
    if (data.username !== undefined) updateData.username = data.username.trim();
    if (data.bio !== undefined) updateData.bio = data.bio.trim() || null;

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        avatar: true,
        bio: true,
        verified: true,
        reputation: true,
      },
    });
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      avatar: user.avatar ?? null,
      bio: user.bio ?? null,
      verified: user.verified,
      reputation: user.reputation,
    };
  }
}
