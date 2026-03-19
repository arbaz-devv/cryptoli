/**
 * Shared SocketService mock for unit tests.
 * All 7 emit methods are jest.fn() stubs.
 */
export function createSocketMock() {
  return {
    emitReviewCreated: jest.fn(),
    emitReviewUpdated: jest.fn(),
    emitReviewVoteUpdated: jest.fn(),
    emitCommentCountUpdated: jest.fn(),
    emitNotificationCreated: jest.fn(),
    emitNotificationRead: jest.fn(),
    emitNotificationsAllRead: jest.fn(),
  };
}
