import { PrismaClient } from '@prisma/client';
import { getTestPrisma, truncateAll } from '../helpers/test-db.utils';
import {
  AnalyticsBufferService,
  BufferedEvent,
} from '../../src/analytics/analytics-buffer.service';

/**
 * Integration tests for AnalyticsBufferService against a real PostgreSQL container.
 * Verifies that createMany writes land in the analytics_events table and that
 * synchronous_commit=off is accepted by PG without errors.
 */
describe('AnalyticsBufferService (Integration)', () => {
  let prisma: PrismaClient;
  let service: AnalyticsBufferService;

  beforeAll(() => {
    prisma = getTestPrisma();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // Pass the real PrismaClient as PrismaService (duck-typed — same interface)
    service = new AnalyticsBufferService(prisma as any);
  });

  afterEach(() => {
    // Clear any timers
    if ((service as any).flushTimer) clearInterval((service as any).flushTimer);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should write buffered events to analytics_events table', async () => {
    const event: BufferedEvent = {
      eventType: 'page_view',
      sessionId: 'integ-session-1',
      userId: null as any,
      ipHash: 'a'.repeat(64),
      country: 'US',
      device: 'desktop',
      browser: 'chrome',
      os: 'linux',
      path: '/home',
      referrer: 'google.com',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'launch',
      durationSeconds: 30,
      properties: { page: 'home' },
    };

    service.push(event);
    await service.flush();

    const rows = await prisma.analyticsEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('page_view');
    expect(rows[0].sessionId).toBe('integ-session-1');
    expect(rows[0].country).toBe('US');
    expect(rows[0].device).toBe('desktop');
    expect(rows[0].browser).toBe('chrome');
    expect(rows[0].path).toBe('/home');
    expect(rows[0].durationSeconds).toBe(30);
    expect(rows[0].properties).toEqual({ page: 'home' });
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('should batch multiple events in a single createMany call', async () => {
    for (let i = 0; i < 5; i++) {
      service.push({
        eventType: `event_${i}`,
        sessionId: `session-${i}`,
      });
    }

    await service.flush();

    const count = await prisma.analyticsEvent.count();
    expect(count).toBe(5);
  });

  it('should accept SET LOCAL synchronous_commit = off without error', async () => {
    // This verifies that the $executeRaw call for synchronous_commit
    // doesn't cause PG to reject the subsequent createMany
    service.push({ eventType: 'sync_commit_test' });
    await expect(service.flush()).resolves.not.toThrow();

    const rows = await prisma.analyticsEvent.findMany({
      where: { eventType: 'sync_commit_test' },
    });
    expect(rows).toHaveLength(1);
  });

  it('should handle events with minimal fields (only eventType)', async () => {
    service.push({ eventType: 'minimal_event' });
    await service.flush();

    const rows = await prisma.analyticsEvent.findMany({
      where: { eventType: 'minimal_event' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBeNull();
    expect(rows[0].userId).toBeNull();
    expect(rows[0].country).toBeNull();
  });
});
