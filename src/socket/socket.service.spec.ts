import { SocketService } from './socket.service';

describe('SocketService', () => {
  let service: SocketService;
  let mockIo: { to: jest.Mock; emit: jest.Mock };

  beforeEach(() => {
    service = new SocketService();
    const emitFn = jest.fn();
    mockIo = {
      to: jest.fn().mockReturnValue({ emit: emitFn }),
      emit: emitFn,
    };
    delete (globalThis as any).__socketIO;
  });

  afterEach(() => {
    delete (globalThis as any).__socketIO;
  });

  describe('when socketIO is not set', () => {
    it('emitReviewCreated should no-op', () => {
      service.emitReviewCreated({ id: 'r1' });
      // no error thrown
    });

    it('emitNotificationCreated should no-op', () => {
      service.emitNotificationCreated('u1', { id: 'n1' });
    });

    it('emitCommentCountUpdated should no-op', () => {
      service.emitCommentCountUpdated('r1', 5);
    });
  });

  describe('when socketIO is set', () => {
    beforeEach(() => {
      (globalThis as any).__socketIO = mockIo;
    });

    it('emitReviewCreated should emit to reviews room', () => {
      service.emitReviewCreated({ id: 'r1' });
      expect(mockIo.to).toHaveBeenCalledWith('reviews');
      expect(mockIo.to('reviews').emit).toHaveBeenCalledWith('review:created', { id: 'r1' });
    });

    it('emitReviewUpdated should emit to reviews room', () => {
      service.emitReviewUpdated({ id: 'r1' });
      expect(mockIo.to).toHaveBeenCalledWith('reviews');
      expect(mockIo.to('reviews').emit).toHaveBeenCalledWith('review:updated', { id: 'r1' });
    });

    it('emitReviewVoteUpdated should emit vote data', () => {
      service.emitReviewVoteUpdated('r1', 10, 2);
      expect(mockIo.to('reviews').emit).toHaveBeenCalledWith('review:vote:updated', {
        reviewId: 'r1',
        helpfulCount: 10,
        downVoteCount: 2,
      });
    });

    it('emitNotificationCreated should emit to user room', () => {
      service.emitNotificationCreated('u1', { id: 'n1' });
      expect(mockIo.to).toHaveBeenCalledWith('user:u1');
      expect(mockIo.to('user:u1').emit).toHaveBeenCalledWith('notification:created', { id: 'n1' });
    });

    it('emitNotificationRead should emit to user room', () => {
      service.emitNotificationRead('u1', { id: 'n1' });
      expect(mockIo.to).toHaveBeenCalledWith('user:u1');
      expect(mockIo.to('user:u1').emit).toHaveBeenCalledWith('notification:read', { id: 'n1' });
    });

    it('emitNotificationsAllRead should emit to user room', () => {
      service.emitNotificationsAllRead('u1', { count: 5 });
      expect(mockIo.to('user:u1').emit).toHaveBeenCalledWith('notification:all-read', { count: 5 });
    });

    it('emitCommentCountUpdated should emit to reviews room', () => {
      service.emitCommentCountUpdated('r1', 42);
      expect(mockIo.to('reviews').emit).toHaveBeenCalledWith('review:comment:count', {
        reviewId: 'r1',
        commentCount: 42,
      });
    });
  });
});
