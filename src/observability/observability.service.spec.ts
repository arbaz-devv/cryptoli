import { ObservabilityService } from './observability.service';

describe('ObservabilityService', () => {
  let service: ObservabilityService;

  beforeEach(() => {
    service = new ObservabilityService();
  });

  it('should aggregate request latency percentiles by route', () => {
    service.recordRequest({
      method: 'GET',
      route: '/api/search',
      durationMs: 10,
      statusCode: 200,
    });
    service.recordRequest({
      method: 'GET',
      route: '/api/search',
      durationMs: 30,
      statusCode: 200,
    });
    service.recordRequest({
      method: 'GET',
      route: '/api/search',
      durationMs: 50,
      statusCode: 503,
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.requests.totals.count).toBe(3);
    expect(snapshot.requests.totals.errorCount).toBe(1);
    expect(snapshot.requests.routes[0].route).toBe('/api/search');
    expect(snapshot.requests.routes[0].p95Ms).toBe(50);
  });

  it('should track cache hit ratios and socket counts', () => {
    service.recordCacheHit('search.public');
    service.recordCacheMiss('search.public');
    service.onSocketConnected('socket-1');
    service.onSocketAuthenticated('socket-1');

    const snapshot = service.getSnapshot();

    expect(snapshot.cache.totals.hits).toBe(1);
    expect(snapshot.cache.totals.misses).toBe(1);
    expect(snapshot.cache.totals.hitRatio).toBe(50);
    expect(snapshot.websocket.connectedClients).toBe(1);
    expect(snapshot.websocket.authenticatedClients).toBe(1);
  });
});
