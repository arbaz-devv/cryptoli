import { ExecutionContext } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

const TEST_JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

export interface MockSessionUser {
  id: string;
  email: string;
  username: string;
  role: string;
  avatar: string | null;
  bio: string | null;
  verified: boolean;
  reputation: number;
}

export function createMockSessionUser(
  overrides: Partial<MockSessionUser> = {},
): MockSessionUser {
  return {
    id: 'test-user-id',
    email: 'test@test.com',
    username: 'testuser',
    role: 'USER',
    avatar: null,
    bio: null,
    verified: false,
    reputation: 0,
    ...overrides,
  };
}

export function createTestJwt(
  payload: Record<string, any> = {},
  options: jwt.SignOptions = {},
): string {
  return jwt.sign(
    {
      userId: 'test-user-id',
      jti: 'test-session-id',
      ...payload,
    },
    TEST_JWT_SECRET,
    {
      expiresIn: '7d',
      ...options,
    },
  );
}

export function createAdminTestJwt(
  overrides: Record<string, any> = {},
): string {
  return jwt.sign(
    {
      type: 'admin',
      email: 'admin@test.com',
      ...overrides,
    },
    TEST_JWT_SECRET,
    { expiresIn: '24h' },
  );
}

export function mockRequest(overrides: Record<string, any> = {}): any {
  return {
    headers: {},
    cookies: {},
    get: jest.fn((name: string) => overrides.headers?.[name.toLowerCase()]),
    ...overrides,
  };
}

export function mockExecutionContext(
  request?: any,
): ExecutionContext {
  const req = request ?? mockRequest();
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
      }),
      getNext: () => jest.fn(),
    }),
    getClass: () => Object,
    getHandler: () => jest.fn(),
    getArgs: () => [req],
    getArgByIndex: (i: number) => [req][i],
    switchToRpc: jest.fn() as any,
    switchToWs: jest.fn() as any,
    getType: () => 'http' as any,
  } as unknown as ExecutionContext;
}
