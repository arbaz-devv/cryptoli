import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import {
  mockExecutionContext,
  mockRequest,
  createMockSessionUser,
} from '../../test/helpers/auth.helpers';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let authService: {
    getSessionTokenFromRequest: jest.Mock;
    getSessionFromToken: jest.Mock;
  };

  beforeEach(() => {
    authService = {
      getSessionTokenFromRequest: jest.fn(),
      getSessionFromToken: jest.fn(),
    };
    guard = new AuthGuard(authService as unknown as AuthService);
  });

  it('should return true and set req.user when session is valid', async () => {
    const user = createMockSessionUser();
    authService.getSessionTokenFromRequest.mockReturnValue('valid-token');
    authService.getSessionFromToken.mockResolvedValue(user);

    const req = mockRequest();
    const ctx = mockExecutionContext(req);

    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(req.user).toEqual(user);
  });

  it('should throw UnauthorizedException when no token', async () => {
    authService.getSessionTokenFromRequest.mockReturnValue(undefined);
    authService.getSessionFromToken.mockResolvedValue(null);

    const ctx = mockExecutionContext(mockRequest());

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      'Authentication required',
    );
  });

  it('should throw UnauthorizedException when token is expired/invalid', async () => {
    authService.getSessionTokenFromRequest.mockReturnValue('expired-token');
    authService.getSessionFromToken.mockResolvedValue(null);

    const ctx = mockExecutionContext(mockRequest());

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException when DB session is missing', async () => {
    authService.getSessionTokenFromRequest.mockReturnValue('valid-jwt-but-no-db-session');
    authService.getSessionFromToken.mockResolvedValue(null);

    const ctx = mockExecutionContext(mockRequest());

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should extract token from request via authService', async () => {
    const user = createMockSessionUser();
    authService.getSessionTokenFromRequest.mockReturnValue('my-token');
    authService.getSessionFromToken.mockResolvedValue(user);

    const req = mockRequest({ headers: { authorization: 'Bearer my-token' } });
    const ctx = mockExecutionContext(req);

    await guard.canActivate(ctx);

    expect(authService.getSessionTokenFromRequest).toHaveBeenCalledWith(req);
    expect(authService.getSessionFromToken).toHaveBeenCalledWith('my-token');
  });
});
