import 'reflect-metadata';
import { AdminAuthController } from './admin-auth.controller';

describe('AdminAuthController', () => {
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
});
