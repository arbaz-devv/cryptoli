import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface BufferedEvent {
  eventType: string;
  sessionId?: string;
  userId?: string;
  ipHash?: string;
  country?: string;
  device?: string;
  browser?: string;
  os?: string;
  timezone?: string;
  path?: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  durationSeconds?: number;
  properties?: Record<string, unknown>;
  createdAt?: Date;
}

@Injectable()
export class AnalyticsBufferService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsBufferService.name);
  private buffer: BufferedEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  readonly FLUSH_INTERVAL_MS = 2_000;
  readonly FLUSH_THRESHOLD = 500;
  readonly MAX_BUFFER = 2_000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Synchronous push — drops and logs on overflow (analytics loss acceptable).
   */
  push(event: BufferedEvent): void {
    if (this.buffer.length >= this.MAX_BUFFER) {
      this.logger.warn(
        `Buffer overflow (${this.MAX_BUFFER}), dropping event: ${event.eventType}`,
      );
      return;
    }
    this.buffer.push(event);

    if (this.buffer.length >= this.FLUSH_THRESHOLD) {
      void this.flush();
    }
  }

  /**
   * Splice before await to prevent race conditions between timer and
   * threshold-triggered flushes. On PG failure: log, do not re-queue.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await this.prisma.$executeRaw`SET LOCAL synchronous_commit = off`;
      await this.prisma.analyticsEvent.createMany({
        data: batch.map((e) => ({
          eventType: e.eventType,
          sessionId: e.sessionId,
          userId: e.userId,
          ipHash: e.ipHash,
          country: e.country,
          device: e.device,
          browser: e.browser,
          os: e.os,
          timezone: e.timezone,
          path: e.path,
          referrer: e.referrer,
          utmSource: e.utmSource,
          utmMedium: e.utmMedium,
          utmCampaign: e.utmCampaign,
          durationSeconds: e.durationSeconds,
          properties: (e.properties ?? {}) as Prisma.InputJsonValue,
          createdAt: e.createdAt ?? new Date(),
        })),
      });
    } catch (err) {
      this.logger.error(
        `Failed to flush ${batch.length} events to PG: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  onModuleInit(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.FLUSH_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /** Exposed for testing — returns current buffer length. */
  get bufferLength(): number {
    return this.buffer.length;
  }
}
