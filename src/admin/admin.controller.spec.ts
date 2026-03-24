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
      getUserSessions: jest
        .fn()
        .mockResolvedValue({ sessions: [], pagination: {} }),
      getUserSessionsExport: jest.fn().mockResolvedValue('csv-data'),
      getUserActivity: jest
        .fn()
        .mockResolvedValue({ activities: [], pagination: {} }),
      rollupAnalytics: jest.fn().mockResolvedValue({
        ok: true,
        rolledUp: 1,
        skipped: 0,
        errors: 0,
        durationMs: 10,
      }),
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
      expect(mockAdminService.updateReviewStatus).toHaveBeenCalledWith(
        'r1',
        'APPROVED',
      );
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

  describe('userSessions()', () => {
    it('should clamp pagination and delegate', async () => {
      await controller.userSessions('u1', { page: -1, limit: 200 } as any);
      expect(mockAdminService.getUserSessions).toHaveBeenCalledWith(
        'u1',
        1,
        100,
      );
    });

    it('should pass through valid page/limit', async () => {
      await controller.userSessions('u1', { page: 2, limit: 10 } as any);
      expect(mockAdminService.getUserSessions).toHaveBeenCalledWith(
        'u1',
        2,
        10,
      );
    });
  });

  describe('userSessionsExport()', () => {
    it('should return StreamableFile for CSV format', async () => {
      mockAdminService.getUserSessionsExport.mockResolvedValue('header\nrow');
      const result = await controller.userSessionsExport('u1', {
        format: 'csv',
      } as any);
      expect(result).toBeDefined();
      expect(mockAdminService.getUserSessionsExport).toHaveBeenCalledWith(
        'u1',
        'csv',
      );
    });

    it('should return JSON array for JSON format', async () => {
      const jsonData = [{ ipHash: 'abc' }];
      mockAdminService.getUserSessionsExport.mockResolvedValue(jsonData);
      const result = await controller.userSessionsExport('u1', {
        format: 'json',
      } as any);
      expect(result).toEqual(jsonData);
      expect(mockAdminService.getUserSessionsExport).toHaveBeenCalledWith(
        'u1',
        'json',
      );
    });
  });

  describe('userActivity()', () => {
    it('should clamp pagination and delegate', async () => {
      await controller.userActivity('u1', { page: 0, limit: 500 } as any);
      expect(mockAdminService.getUserActivity).toHaveBeenCalledWith(
        'u1',
        1,
        100,
      );
    });
  });

  describe('rollup()', () => {
    it('should delegate to rollupAnalytics with date', async () => {
      await controller.rollup({ date: '2026-03-20' } as any);
      expect(mockAdminService.rollupAnalytics).toHaveBeenCalledWith({
        date: '2026-03-20',
        from: undefined,
        to: undefined,
      });
    });

    it('should delegate with from/to range', async () => {
      await controller.rollup({ from: '2026-03-01', to: '2026-03-10' } as any);
      expect(mockAdminService.rollupAnalytics).toHaveBeenCalledWith({
        date: undefined,
        from: '2026-03-01',
        to: '2026-03-10',
      });
    });
  });
});
