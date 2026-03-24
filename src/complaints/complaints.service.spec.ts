import { BadRequestException } from '@nestjs/common';
import { ComplaintsService } from './complaints.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createPrismaMock } from '../../test/helpers/prisma.mock';
import type { AnalyticsContext } from '../analytics/analytics-context';

describe('ComplaintsService', () => {
  let service: ComplaintsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let analyticsMock: { track: jest.Mock };

  const mockCtx: AnalyticsContext = {
    ip: '1.2.3.4',
    userAgent: 'TestAgent/1.0',
    country: 'US',
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    analyticsMock = {
      track: jest.fn().mockResolvedValue(undefined),
    };
    service = new ComplaintsService(
      prisma as unknown as PrismaService,
      analyticsMock as any,
    );
  });

  describe('vote()', () => {
    it('should create a new UP vote and recount', async () => {
      const txMock = {
        complaint: {
          findUnique: jest.fn().mockResolvedValue({ id: 'c1' }),
          update: jest.fn(),
        },
        complaintVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.complaintVote.count
        .mockResolvedValueOnce(1) // UP
        .mockResolvedValueOnce(0); // DOWN

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      const result = await service.vote('c1', 'UP', 'u1');

      expect(txMock.complaintVote.create).toHaveBeenCalledWith({
        data: { userId: 'u1', complaintId: 'c1', voteType: 'UP' },
      });
      expect(txMock.complaint.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { helpfulCount: 1, downVoteCount: 0 },
      });
      expect(result).toEqual({
        voteType: 'UP',
        helpfulCount: 1,
        downVoteCount: 0,
      });
    });

    it('should toggle off when same vote exists (UP→delete)', async () => {
      const txMock = {
        complaint: {
          findUnique: jest.fn().mockResolvedValue({ id: 'c1' }),
          update: jest.fn(),
        },
        complaintVote: {
          findUnique: jest.fn().mockResolvedValue({ id: 'v1', voteType: 'UP' }),
          delete: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
        },
      };

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      const result = await service.vote('c1', 'UP', 'u1');

      expect(txMock.complaintVote.delete).toHaveBeenCalledWith({
        where: { id: 'v1' },
      });
      expect(result.voteType).toBeNull();
    });

    it('should switch vote when opposite exists (UP→DOWN)', async () => {
      const txMock = {
        complaint: {
          findUnique: jest.fn().mockResolvedValue({ id: 'c1' }),
          update: jest.fn(),
        },
        complaintVote: {
          findUnique: jest.fn().mockResolvedValue({ id: 'v1', voteType: 'UP' }),
          update: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.complaintVote.count
        .mockResolvedValueOnce(0) // UP
        .mockResolvedValueOnce(1); // DOWN

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      const result = await service.vote('c1', 'DOWN', 'u1');

      expect(txMock.complaintVote.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { voteType: 'DOWN' },
      });
      expect(result).toEqual({
        voteType: 'DOWN',
        helpfulCount: 0,
        downVoteCount: 1,
      });
    });

    it('should reject invalid voteType', async () => {
      await expect(service.vote('c1', 'INVALID', 'u1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundError for missing complaint', async () => {
      const txMock = {
        complaint: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await expect(service.vote('bad', 'UP', 'u1')).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('create()', () => {
    it('should create complaint with status OPEN', async () => {
      const complaint = {
        id: 'c1',
        title: 'Test Complaint',
        content: 'Content here',
        status: 'OPEN',
        authorId: 'u1',
        author: { id: 'u1', username: 'user1' },
      };
      prisma.complaint.create.mockResolvedValue(complaint);

      const result = await service.create(
        { title: 'Test Complaint', content: 'Content here' },
        'u1',
      );

      expect(result.status).toBe('OPEN');
      const createCall = prisma.complaint.create.mock.calls[0][0];
      expect(createCall.data.status).toBe('OPEN');
      expect(createCall.data.authorId).toBe('u1');
    });

    it('should reject invalid body via Zod', async () => {
      await expect(service.create({ title: '' }, 'u1')).rejects.toThrow();
    });
  });

  describe('getById()', () => {
    it('should throw NotFoundError for missing complaint', async () => {
      prisma.complaint.findUnique.mockResolvedValue(null);

      await expect(service.getById('bad')).rejects.toThrow(NotFoundError);
    });

    it('should return complaint with userVote when user provided', async () => {
      prisma.complaint.findUnique.mockResolvedValue({
        id: 'c1',
        title: 'Test',
        replies: [],
      });
      prisma.complaintVote.findUnique.mockResolvedValue({ voteType: 'UP' });

      const result = await service.getById('c1', { id: 'u1' });

      expect(result.userVote).toBe('UP');
    });

    it('should return null userVote when no user', async () => {
      prisma.complaint.findUnique.mockResolvedValue({
        id: 'c1',
        title: 'Test',
        replies: [],
      });

      const result = await service.getById('c1');

      expect(result.userVote).toBeNull();
    });
  });

  describe('list()', () => {
    it('should return paginated complaints with userVote enrichment', async () => {
      prisma.complaint.findMany.mockResolvedValue([
        { id: 'c1', title: 'Test' },
        { id: 'c2', title: 'Test 2' },
      ]);
      prisma.complaint.count.mockResolvedValue(2);
      prisma.complaintVote.findMany.mockResolvedValue([
        { complaintId: 'c1', voteType: 'UP' },
      ]);

      const result = await service.list(
        1,
        10,
        undefined,
        undefined,
        undefined,
        { id: 'u1' },
      );

      expect(result.complaints).toHaveLength(2);
      expect((result.complaints[0] as any).userVote).toBe('UP');
      expect((result.complaints[1] as any).userVote).toBeNull();
      expect(result.pagination.total).toBe(2);
    });

    it('should return null userVote for all when no user', async () => {
      prisma.complaint.findMany.mockResolvedValue([{ id: 'c1' }]);
      prisma.complaint.count.mockResolvedValue(1);

      const result = await service.list(1, 10);

      expect((result.complaints[0] as any).userVote).toBeNull();
    });
  });

  describe('reply()', () => {
    it('should create reply and transition OPEN→IN_PROGRESS', async () => {
      prisma.complaint.findUnique.mockResolvedValue({
        id: 'c1',
        companyId: 'comp1',
        status: 'OPEN',
        company: { id: 'comp1' },
      });
      prisma.company.findUnique.mockResolvedValue({ id: 'comp1' });
      prisma.complaintReply.create.mockResolvedValue({
        id: 'r1',
        content: 'Reply text',
        company: { id: 'comp1', name: 'Test', logo: null },
      });
      prisma.complaint.update.mockResolvedValue({});

      const result = await service.reply('c1', 'Reply text');

      expect(result.id).toBe('r1');
      expect(prisma.complaint.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'IN_PROGRESS' },
      });
    });

    it('should throw NotFoundError for missing complaint', async () => {
      prisma.complaint.findUnique.mockResolvedValue(null);

      await expect(service.reply('bad', 'text')).rejects.toThrow(NotFoundError);
    });

    it('should throw BadRequestException when no companyId', async () => {
      prisma.complaint.findUnique.mockResolvedValue({
        id: 'c1',
        companyId: null,
        status: 'OPEN',
        company: null,
      });

      await expect(service.reply('c1', 'text')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should not transition when status is not OPEN', async () => {
      prisma.complaint.findUnique.mockResolvedValue({
        id: 'c1',
        companyId: 'comp1',
        status: 'IN_PROGRESS',
        company: { id: 'comp1' },
      });
      prisma.company.findUnique.mockResolvedValue({ id: 'comp1' });
      prisma.complaintReply.create.mockResolvedValue({
        id: 'r1',
        content: 'text',
      });

      await service.reply('c1', 'text');

      expect(prisma.complaint.update).not.toHaveBeenCalled();
    });
  });

  describe('analytics tracking', () => {
    it('should track complaint_created with context', async () => {
      prisma.complaint.create.mockResolvedValue({
        id: 'c1',
        title: 'Test',
        content: 'Content',
        status: 'OPEN',
        authorId: 'u1',
      });

      await service.create(
        { title: 'Test', content: 'Content' },
        'u1',
        mockCtx,
      );

      expect(analyticsMock.track).toHaveBeenCalledWith(
        '1.2.3.4',
        'TestAgent/1.0',
        {
          event: 'complaint_created',
          consent: true,
          userId: 'u1',
          properties: {
            complaintId: 'c1',
            companyId: undefined,
            productId: undefined,
          },
        },
        'US',
      );
    });

    it('should track vote_cast after transaction completes', async () => {
      const txMock = {
        complaint: {
          findUnique: jest.fn().mockResolvedValue({ id: 'c1' }),
          update: jest.fn(),
        },
        complaintVote: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          count: jest.fn(),
        },
      };
      txMock.complaintVote.count
        .mockResolvedValueOnce(1) // UP
        .mockResolvedValueOnce(0); // DOWN

      prisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.vote('c1', 'UP', 'u1', mockCtx);

      expect(analyticsMock.track).toHaveBeenCalledWith(
        '1.2.3.4',
        'TestAgent/1.0',
        {
          event: 'vote_cast',
          consent: true,
          userId: 'u1',
          properties: { complaintId: 'c1', voteType: 'UP' },
        },
        'US',
      );
    });

    it('should not track when analyticsCtx is absent', async () => {
      prisma.complaint.create.mockResolvedValue({
        id: 'c1',
        title: 'Test',
        content: 'Content',
        status: 'OPEN',
        authorId: 'u1',
      });

      await service.create({ title: 'Test', content: 'Content' }, 'u1');

      expect(analyticsMock.track).not.toHaveBeenCalled();
    });

    it('should not track when analyticsService is undefined', async () => {
      const serviceNoAnalytics = new ComplaintsService(
        prisma as unknown as PrismaService,
      );
      prisma.complaint.create.mockResolvedValue({
        id: 'c1',
        title: 'Test',
        content: 'Content',
        status: 'OPEN',
        authorId: 'u1',
      });

      await serviceNoAnalytics.create(
        { title: 'Test', content: 'Content' },
        'u1',
        mockCtx,
      );

      expect(analyticsMock.track).not.toHaveBeenCalled();
    });
  });
});
