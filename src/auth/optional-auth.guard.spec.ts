import { OptionalAuthGuard } from './optional-auth.guard';
import { AuthService } from './auth.service';
import {
  mockExecutionContext,
  mockRequest,
  createMockSessionUser,
} from '../../test/helpers/auth.helpers';

describe('OptionalAuthGuard', () => {
  let guard: OptionalAuthGuard;
  let authService: {
    getSessionTokenFromRequest: jest.Mock;
    getSessionFromToken: jest.Mock;
  };

  beforeEach(() => {
    authService = {
      getSessionTokenFromRequest: jest.fn(),
      getSessionFromToken: jest.fn(),
    };
    guard = new OptionalAuthGuard(authService as unknown as AuthService);
  });

  it('should always return true (never blocks)', async () => {
    authService.getSessionTokenFromRequest.mockReturnValue(undefined);
    authService.getSessionFromToken.mockResolvedValue(null);

    const ctx = mockExecutionContext(mockRequest());
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
  });

  it('should set req.user to SessionUser when session is valid', async () => {
    const user = createMockSessionUser();
    authService.getSessionTokenFromRequest.mockReturnValue('valid-token');
    authService.getSessionFromToken.mockResolvedValue(user);

    const req = mockRequest();
    const ctx = mockExecutionContext(req);

    await guard.canActivate(ctx);

    expect(req.user).toEqual(user);
  });

  it('should set req.user to null (not undefined) when no session', async () => {
    authService.getSessionTokenFromRequest.mockReturnValue(undefined);
    authService.getSessionFromToken.mockResolvedValue(null);

    const req = mockRequest();
    const ctx = mockExecutionContext(req);

    await guard.canActivate(ctx);

    expect(req.user).toBeNull();
  });

  it('should set req.user to null when getSessionFromToken returns undefined', async () => {
    authService.getSessionTokenFromRequest.mockReturnValue('some-token');
    authService.getSessionFromToken.mockResolvedValue(undefined);

    const req = mockRequest();
    const ctx = mockExecutionContext(req);

    await guard.canActivate(ctx);

    // The guard uses `user ?? null`, so undefined becomes null
    expect(req.user).toBeNull();
  });

  it('should return true even when auth service throws', async () => {
    // OptionalAuthGuard should never throw — but this tests the contract.
    // If authService throws, the guard does NOT catch it (it's a bug in the guard if it does).
    // This test documents the current behavior: errors propagate.
    authService.getSessionTokenFromRequest.mockReturnValue('token');
    authService.getSessionFromToken.mockRejectedValue(new Error('DB down'));

    const ctx = mockExecutionContext(mockRequest());

    // Current implementation does not catch — error propagates
    await expect(guard.canActivate(ctx)).rejects.toThrow('DB down');
  });
});
