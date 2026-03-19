import 'reflect-metadata';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

describe('AdminController', () => {
  let controller: AdminController;
  let mockAdminService: Record<string, jest.Mock>;

  beforeEach(() => {
    mockAdminService = {
      getStats: jest.fn().mockResolvedValue({ totalUsers: 1 }),
      getUsers: jest.fn().mockResolvedValue({ users: [], pagination: {} }),
      getUserDetail: jest.fn().mockResolvedValue({ user: {} }),
      getReviews: jest.fn().mockResolvedValue({ reviews: [], pagination: {} }),
      getReview: jest.fn().mockResolvedValue({ id: 'r1' }),
      updateReviewStatus: jest.fn().mockResolvedValue({ ok: true }),
      getRatings: jest.fn().mockResolvedValue({ ratings: [], pagination: {} }),
    };
    controller = new AdminController(mockAdminService as any);
  });

  it('should have AdminGuard on the controller', () => {
    const guards = Reflect.getMetadata('__guards__', AdminController);
    expect(guards).toBeDefined();
    expect(guards).toContain(AdminGuard);
  });

  describe('stats()', () => {
    it('should delegate to admin.getStats()', async () => {
      const result = await controller.stats();
      expect(mockAdminService.getStats).toHaveBeenCalled();
      expect(result.totalUsers).toBe(1);
    });
  });

  describe('users()', () => {
    it('should clamp page and limit', async () => {
      await controller.users({ page: -1, limit: 200 } as any);

      expect(mockAdminService.getUsers).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 100 }),
      );
    });

    it('should pass search and date params', async () => {
      await controller.users({
        page: 1,
        limit: 20,
        q: 'alice',
        dateFrom: '2026-01-01',
        dateTo: '2026-01-31',
      } as any);

      expect(mockAdminService.getUsers).toHaveBeenCalledWith(
        expect.objectContaining({
          q: 'alice',
          dateFrom: '2026-01-01',
          dateTo: '2026-01-31',
        }),
      );
    });
  });

  describe('userDetail()', () => {
    it('should pass lazy flag to service', async () => {
      await controller.userDetail('u1', { lazy: true } as any);
      expect(mockAdminService.getUserDetail).toHaveBeenCalledWith('u1', true);
    });

    it('should default lazy to false', async () => {
      await controller.userDetail('u1', {} as any);
      expect(mockAdminService.getUserDetail).toHaveBeenCalledWith('u1', false);
    });
  });

  describe('reviews()', () => {
    it('should clamp pagination and pass filters', async () => {
      await controller.reviews({
        page: 0,
        limit: 500,
        status: 'PENDING',
        q: 'test',
      } as any);

      expect(mockAdminService.getReviews).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 1,
          limit: 100,
          status: 'PENDING',
          q: 'test',
        }),
      );
    });
  });

  describe('getReview()', () => {
    it('should delegate to admin.getReview()', async () => {
      await controller.getReview('r1', { lazy: false } as any);
      expect(mockAdminService.getReview).toHaveBeenCalledWith('r1', false);
    });
  });

  describe('updateReviewStatus()', () => {
    it('should delegate to admin.updateReviewStatus()', async () => {
      await controller.updateReviewStatus('r1', { status: 'APPROVED' } as any);
      expect(mockAdminService.updateReviewStatus).toHaveBeenCalledWith('r1', 'APPROVED');
    });
  });

  describe('ratings()', () => {
    it('should clamp pagination defaults', async () => {
      await controller.ratings({} as any);
      expect(mockAdminService.getRatings).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 20 }),
      );
    });
  });
});
