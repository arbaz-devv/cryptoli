import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ObservabilityService } from '../observability/observability.service';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(private readonly observability: ObservabilityService) {
    super({
      // Prisma log config requires `as any` — typed overloads don't cover event+stdout mix
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        ...(process.env.NODE_ENV === 'development'
          ? [{ emit: 'stdout', level: 'warn' }]
          : []),
      ] as const as any,
    });

    // Prisma's $on is not exposed on PrismaClient's public type — cast required
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    (this as any).$on('query', (event: { query: string; duration: number }) => {
      const normalizedQuery = event.query
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);

      this.observability.recordDbOperation({
        operation: `sql:${normalizedQuery}`,
        durationMs: event.duration,
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    (this as any).$on('error', () => {
      this.observability.recordDbOperation({
        operation: 'sql:error',
        durationMs: 0,
        failed: true,
      });
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
