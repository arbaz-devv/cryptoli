import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import { createSocketMock } from '../../test/helpers/socket.mock';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let socketMock: ReturnType<typeof createSocketMock>;
  let pushMock: { sendToUser: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaMock();
    socketMock = createSocketMock();
    pushMock = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    service = new NotificationsService(
      prisma as unknown as PrismaService,
      socketMock as any,
      pushMock as any,
    );
  });

  describe('createForUser()', () => {
    it('should create DB record, emit socket, and send push', async () => {
      const notification = { id: 'n1', userId: 'u1', type: 'MENTION', title: 'Test' };
      prisma.notification.create.mockResolvedValue(notification);
      prisma.notification.count.mockResolvedValue(3);

      const result = await service.createForUser({
        userId: 'u1',
        type: 'MENTION' as any,
        title: 'Test',
        message: 'Hello',
        link: '/test',
      });

      expect(result).toEqual(notification);
      expect(socketMock.emitNotificationCreated).toHaveBeenCalledWith('u1', {
        notification,
        unreadCount: 3,
      });
      expect(pushMock.sendToUser).toHaveBeenCalledWith('u1', {
        title: 'Test',
        body: 'Hello',
        url: '/test',
      });
    });

    it('should swallow push errors gracefully', async () => {
      prisma.notification.create.mockResolvedValue({ id: 'n1' });
      prisma.notification.count.mockResolvedValue(1);
      pushMock.sendToUser.mockRejectedValue(new Error('Push failed'));

      // Should not throw
      const result = await service.createForUser({
        userId: 'u1',
        type: 'MENTION' as any,
        title: 'Test',
        message: 'Hello',
      });

      expect(result).toBeDefined();
    });
  });

  describe('listForUser()', () => {
    it('should return last 25 notifications with unread count', async () => {
      prisma.notification.findMany.mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);
      prisma.notification.count.mockResolvedValue(1);

      const result = await service.listForUser('u1');

      expect(result.notifications).toHaveLength(2);
      expect(result.unreadCount).toBe(1);
      const findCall = prisma.notification.findMany.mock.calls[0][0];
      expect(findCall.take).toBe(25);
    });
  });

  describe('markRead()', () => {
    it('should mark notification as read and emit socket', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      prisma.notification.count.mockResolvedValue(2);

      const result = await service.markRead('n1', 'u1');

      expect(result.success).toBe(true);
      expect(result.unreadCount).toBe(2);
      expect(socketMock.emitNotificationRead).toHaveBeenCalledWith('u1', {
        notificationId: 'n1',
        unreadCount: 2,
      });
    });

    it('should return success:false when notification not found/owned', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      prisma.notification.count.mockResolvedValue(5);

      const result = await service.markRead('bad', 'u1');

      expect(result.success).toBe(false);
      expect(socketMock.emitNotificationRead).not.toHaveBeenCalled();
    });
  });

  describe('markAllRead()', () => {
    it('should mark all as read and emit socket', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 5 });

      const result = await service.markAllRead('u1');

      expect(result.success).toBe(true);
      expect(result.unreadCount).toBe(0);
      expect(socketMock.emitNotificationsAllRead).toHaveBeenCalledWith('u1', {
        unreadCount: 0,
      });
    });
  });
});
