import { Injectable } from '@nestjs/common';

const MAX_SAMPLES_PER_SERIES = 200;

type LatencySeries = {
  count: number;
  errorCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  samples: number[];
  lastSeenAt: string | null;
  lastStatusCode?: number;
};

type RequestSeries = LatencySeries & {
  method: string;
  route: string;
};

type CacheSeries = {
  hits: number;
  misses: number;
};

type SocketConnectionState = {
  authenticated: boolean;
};

function pushSample(samples: number[], value: number) {
  samples.push(value);
  if (samples.length > MAX_SAMPLES_PER_SERIES) {
    samples.shift();
  }
}

function percentile(samples: number[], ratio: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return Number(sorted[index].toFixed(2));
}

function hitRatio(hits: number, misses: number): number {
  const total = hits + misses;
  if (total === 0) return 0;
  return Number(((hits / total) * 100).toFixed(2));
}

function toMb(value: number): number {
  return Number((value / (1024 * 1024)).toFixed(2));
}

/** `product` = Cryptoi app traffic only (excludes admin API routes and admin cache stores). */
export type ObservabilitySnapshotScope = 'all' | 'product';

@Injectable()
export class ObservabilityService {
  private readonly startedAt = Date.now();
  private readonly requestMetrics = new Map<string, RequestSeries>();
  private readonly dbMetrics = new Map<string, LatencySeries>();
  private readonly cacheMetrics = new Map<string, CacheSeries>();
  private readonly socketConnections = new Map<string, SocketConnectionState>();

  recordRequest(input: {
    method: string;
    route: string;
    durationMs: number;
    statusCode: number;
  }) {
    const key = `${input.method} ${input.route}`;
    const metric = this.requestMetrics.get(key) ?? {
      method: input.method,
      route: input.route,
      count: 0,
      errorCount: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      samples: [],
      lastSeenAt: null,
      lastStatusCode: undefined,
    };

    metric.count += 1;
    if (input.statusCode >= 500) {
      metric.errorCount += 1;
    }
    metric.totalDurationMs += input.durationMs;
    metric.maxDurationMs = Math.max(metric.maxDurationMs, input.durationMs);
    metric.lastSeenAt = new Date().toISOString();
    metric.lastStatusCode = input.statusCode;
    pushSample(metric.samples, input.durationMs);
    this.requestMetrics.set(key, metric);
  }

  recordDbOperation(input: {
    operation: string;
    durationMs: number;
    failed?: boolean;
  }) {
    const metric = this.dbMetrics.get(input.operation) ?? {
      count: 0,
      errorCount: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      samples: [],
      lastSeenAt: null,
    };

    metric.count += 1;
    if (input.failed) {
      metric.errorCount += 1;
    }
    metric.totalDurationMs += input.durationMs;
    metric.maxDurationMs = Math.max(metric.maxDurationMs, input.durationMs);
    metric.lastSeenAt = new Date().toISOString();
    pushSample(metric.samples, input.durationMs);
    this.dbMetrics.set(input.operation, metric);
  }

  recordCacheHit(name: string) {
    const metric = this.cacheMetrics.get(name) ?? { hits: 0, misses: 0 };
    metric.hits += 1;
    this.cacheMetrics.set(name, metric);
  }

  recordCacheMiss(name: string) {
    const metric = this.cacheMetrics.get(name) ?? { hits: 0, misses: 0 };
    metric.misses += 1;
    this.cacheMetrics.set(name, metric);
  }

  onSocketConnected(socketId: string) {
    this.socketConnections.set(socketId, { authenticated: false });
  }

  onSocketAuthenticated(socketId: string) {
    const current = this.socketConnections.get(socketId);
    if (!current) {
      this.socketConnections.set(socketId, { authenticated: true });
      return;
    }
    current.authenticated = true;
    this.socketConnections.set(socketId, current);
  }

  onSocketDisconnected(socketId: string) {
    this.socketConnections.delete(socketId);
  }

  private serializeLatencyMetric(key: string, metric: LatencySeries) {
    return {
      key,
      count: metric.count,
      errorCount: metric.errorCount,
      avgMs:
        metric.count > 0
          ? Number((metric.totalDurationMs / metric.count).toFixed(2))
          : 0,
      p50Ms: percentile(metric.samples, 0.5),
      p95Ms: percentile(metric.samples, 0.95),
      p99Ms: percentile(metric.samples, 0.99),
      maxMs: Number(metric.maxDurationMs.toFixed(2)),
      lastSeenAt: metric.lastSeenAt,
      lastStatusCode: metric.lastStatusCode,
    };
  }

  getSnapshot(options?: { scope?: ObservabilitySnapshotScope }) {
    const scope = options?.scope ?? 'all';

    const requestEntries = [...this.requestMetrics.entries()].filter(
      ([, metric]) =>
        scope === 'product' ? !metric.route.startsWith('/api/admin') : true,
    );

    const allRequestRoutes = requestEntries
      .map(([key, metric]) => ({
        method: metric.method,
        route: metric.route,
        ...this.serializeLatencyMetric(key, metric),
      }))
      .sort((a, b) => b.p95Ms - a.p95Ms);

    const requestRoutes = allRequestRoutes.slice(0, 20);
    const totalRequests = allRequestRoutes.reduce(
      (sum, item) => sum + item.count,
      0,
    );
    const totalRequestErrors = allRequestRoutes.reduce(
      (sum, item) => sum + item.errorCount,
      0,
    );

    const dbOperations = [...this.dbMetrics.entries()]
      .map(([key, metric]) => this.serializeLatencyMetric(key, metric))
      .sort((a, b) => b.p95Ms - a.p95Ms)
      .slice(0, 20);

    const cacheEntries = [...this.cacheMetrics.entries()].filter(([name]) =>
      scope === 'product' ? !name.startsWith('admin.') : true,
    );

    const cacheStores = cacheEntries
      .map(([name, metric]) => ({
        name,
        hits: metric.hits,
        misses: metric.misses,
        hitRatio: hitRatio(metric.hits, metric.misses),
      }))
      .sort((a, b) => b.hitRatio - a.hitRatio);
    const totalDbOps = dbOperations.reduce((sum, item) => sum + item.count, 0);
    const totalDbErrors = dbOperations.reduce(
      (sum, item) => sum + item.errorCount,
      0,
    );
    const totalCacheHits = cacheStores.reduce(
      (sum, item) => sum + item.hits,
      0,
    );
    const totalCacheMisses = cacheStores.reduce(
      (sum, item) => sum + item.misses,
      0,
    );
    const memoryUsage = process.memoryUsage();

    return {
      generatedAt: new Date().toISOString(),
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      requests: {
        totals: {
          count: totalRequests,
          errorCount: totalRequestErrors,
        },
        routes: requestRoutes,
      },
      database: {
        totals: {
          count: totalDbOps,
          errorCount: totalDbErrors,
        },
        operations: dbOperations,
      },
      cache: {
        totals: {
          hits: totalCacheHits,
          misses: totalCacheMisses,
          hitRatio: hitRatio(totalCacheHits, totalCacheMisses),
        },
        stores: cacheStores,
      },
      runtime: {
        process: {
          pid: process.pid,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          memory: {
            rssBytes: memoryUsage.rss,
            heapTotalBytes: memoryUsage.heapTotal,
            heapUsedBytes: memoryUsage.heapUsed,
            externalBytes: memoryUsage.external,
            arrayBuffersBytes: memoryUsage.arrayBuffers,
            rssMb: toMb(memoryUsage.rss),
            heapTotalMb: toMb(memoryUsage.heapTotal),
            heapUsedMb: toMb(memoryUsage.heapUsed),
            externalMb: toMb(memoryUsage.external),
            arrayBuffersMb: toMb(memoryUsage.arrayBuffers),
          },
        },
      },
      websocket: {
        connectedClients: this.socketConnections.size,
        authenticatedClients: [...this.socketConnections.values()].filter(
          (socket) => socket.authenticated,
        ).length,
      },
      queues: {
        configured: false,
        queues: [] as Array<unknown>,
      },
      syntheticChecks: [
        {
          name: 'public-feed',
          method: 'GET',
          path: '/api/feed',
          expectedStatus: 200,
        },
        {
          name: 'public-search',
          method: 'GET',
          path: '/api/search?q=bitcoin&type=all&limit=5',
          expectedStatus: 200,
        },
        {
          name: 'auth-login',
          method: 'POST',
          path: '/api/auth/login',
          expectedStatus: 200,
        },
      ],
    };
  }
}
