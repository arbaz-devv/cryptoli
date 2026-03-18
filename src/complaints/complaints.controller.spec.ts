import 'reflect-metadata';
import { ComplaintsController } from './complaints.controller';
import { AdminGuard } from '../admin/admin.guard';
import { AuthGuard } from '../auth/auth.guard';

describe('ComplaintsController', () => {
  it('should use AdminGuard on reply endpoint', () => {
    const guards: unknown[] = Reflect.getMetadata(
      '__guards__',
      ComplaintsController.prototype.reply,
    );

    expect(guards).toBeDefined();
    expect(guards).toContain(AdminGuard);
  });

  it('should NOT use AuthGuard on reply endpoint', () => {
    const guards: unknown[] = Reflect.getMetadata(
      '__guards__',
      ComplaintsController.prototype.reply,
    );

    expect(guards).not.toContain(AuthGuard);
  });

  it('should still use AuthGuard on create endpoint', () => {
    const guards: unknown[] = Reflect.getMetadata(
      '__guards__',
      ComplaintsController.prototype.create,
    );

    expect(guards).toContain(AuthGuard);
  });
});
