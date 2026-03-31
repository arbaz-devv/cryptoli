import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ObservabilityService } from '../observability/observability.service';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(private readonly observability: ObservabilityService) {
    super({
      log: (
        [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'error' },
          ...(process.env.NODE_ENV === 'development'
            ? [{ emit: 'stdout', level: 'warn' }]
            : []),
        ] as const
      ) as any,
    });

    (this as any).$on('query', (event: any) => {
      const normalizedQuery = event.query
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);

      this.observability.recordDbOperation({
        operation: `sql:${normalizedQuery}`,
        durationMs: event.duration,
      });
    });

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
