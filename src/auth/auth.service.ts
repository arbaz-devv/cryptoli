import { Injectable } from '@nestjs/common';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '../config/config.service';

export interface SessionUser {
  id: string;
  email: string;
  username: string;
  role: string;
  name: string | null;
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
  ) {}

  async findUserByEmailOrUsername(email: string, username: string) {
    return this.prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    });
  }

  async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async createUser(input: {
    email: string;
    username: string;
    passwordHash: string;
    name?: string;
  }) {
    return this.prisma.user.create({
      data: {
        email: input.email,
        username: input.username,
        passwordHash: input.passwordHash,
        name: input.name,
      },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        name: true,
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

  async createSession(userId: string): Promise<string> {
    const token = jwt.sign({ userId }, this.config.jwtSecret, {
      expiresIn: '7d',
    });
    await this.prisma.session.create({
      data: {
        userId,
        token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
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
        where: { token },
        include: { user: true },
      });
      if (!session || session.expiresAt < new Date()) return null;
      return {
        id: session.user.id,
        email: session.user.email,
        username: session.user.username,
        role: session.user.role,
        name: session.user.name ?? null,
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
    await this.prisma.session.deleteMany({ where: { token } });
  }

  async getUserById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
    });
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
  }

  async updateProfile(
    userId: string,
    data: { name?: string; username?: string; bio?: string },
  ): Promise<SessionUser> {
    const updateData: {
      name?: string | null;
      username?: string;
      bio?: string | null;
    } = {};
    if (data.name !== undefined) updateData.name = data.name.trim() || null;
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
        name: true,
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
      name: user.name ?? null,
      avatar: user.avatar ?? null,
      bio: user.bio ?? null,
      verified: user.verified,
      reputation: user.reputation,
    };
  }
}
