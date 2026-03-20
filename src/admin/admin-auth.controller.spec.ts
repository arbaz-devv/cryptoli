import 'reflect-metadata';
import { AdminAuthController } from './admin-auth.controller';

describe('AdminAuthController', () => {
  let controller: AdminAuthController;
  let mockAdminAuth: Record<string, jest.Mock>;

  beforeEach(() => {
    mockAdminAuth = {
      login: jest.fn(),
      isLoginEnabled: jest.fn(),
    };
    controller = new AdminAuthController(mockAdminAuth as any);
  });

  it('should have @Throttle decorator on login with limit 5 for both tiers', () => {
    const login = AdminAuthController.prototype.login;

    expect(Reflect.getMetadata('THROTTLER:LIMITshort', login)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLshort', login)).toBe(60_000);
    expect(Reflect.getMetadata('THROTTLER:LIMITlong', login)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLlong', login)).toBe(60_000);
  });

  it('should NOT have @Throttle decorator on config method', () => {
    const config = AdminAuthController.prototype.config;

    expect(Reflect.getMetadata('THROTTLER:LIMITshort', config)).toBeUndefined();
    expect(Reflect.getMetadata('THROTTLER:LIMITlong', config)).toBeUndefined();
  });

  describe('login()', () => {
    it('should delegate to adminAuth.login with email and password', async () => {
      const token = { token: 'jwt-token-123' };
      mockAdminAuth.login.mockResolvedValue(token);

      const result = await controller.login({
        email: 'admin@test.com',
        password: 'secret',
      });

      expect(mockAdminAuth.login).toHaveBeenCalledWith(
        'admin@test.com',
        'secret',
      );
      expect(result).toEqual(token);
    });

    it('should propagate UnauthorizedException from service', async () => {
      mockAdminAuth.login.mockRejectedValue(new Error('Invalid credentials'));

      await expect(
        controller.login({ email: 'wrong@test.com', password: 'bad' }),
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('config()', () => {
    it('should return loginEnabled: true when configured', () => {
      mockAdminAuth.isLoginEnabled.mockReturnValue(true);
      expect(controller.config()).toEqual({ loginEnabled: true });
    });

    it('should return loginEnabled: false when not configured', () => {
      mockAdminAuth.isLoginEnabled.mockReturnValue(false);
      expect(controller.config()).toEqual({ loginEnabled: false });
    });
  });
});
