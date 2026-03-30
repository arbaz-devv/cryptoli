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

  it('product scope excludes admin HTTP routes and admin cache stores', () => {
    service.recordRequest({
      method: 'GET',
      route: '/api/feed',
      durationMs: 12,
      statusCode: 200,
    });
    service.recordRequest({
      method: 'GET',
      route: '/api/admin/users',
      durationMs: 8,
      statusCode: 200,
    });
    service.recordCacheHit('admin.stats');
    service.recordCacheMiss('admin.stats');
    service.recordCacheHit('search.public');

    const product = service.getSnapshot({ scope: 'product' });

    expect(product.requests.totals.count).toBe(1);
    expect(product.requests.routes).toHaveLength(1);
    expect(product.requests.routes[0].route).toBe('/api/feed');
    expect(product.cache.stores.map((s) => s.name)).toEqual(['search.public']);
    expect(product.cache.totals.hits).toBe(1);
    expect(product.cache.totals.misses).toBe(0);

    const allScope = service.getSnapshot({ scope: 'all' });
    expect(allScope.requests.totals.count).toBe(2);
    expect(allScope.cache.stores.some((s) => s.name === 'admin.stats')).toBe(true);
  });
});
