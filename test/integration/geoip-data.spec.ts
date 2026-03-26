import * as geoip from 'geoip-lite';

/**
 * Verifies the bundled geoip-lite database is present, loadable, and
 * produces correct results for well-known IPs. Catches stale or
 * corrupted data files that would silently degrade country/timezone
 * resolution to 'XX' for all lookups.
 */
describe('GeoIP Database Integrity', () => {
  it('should resolve Google DNS (8.8.8.8) to US', () => {
    const result = geoip.lookup('8.8.8.8');
    expect(result).not.toBeNull();
    expect(result!.country).toBe('US');
    expect(result!.timezone).toBeDefined();
    expect(result!.timezone.length).toBeGreaterThan(0);
  });

  it('should resolve Cloudflare DNS (1.1.1.1) to a valid country', () => {
    const result = geoip.lookup('1.1.1.1');
    expect(result).not.toBeNull();
    expect(result!.country).toMatch(/^[A-Z]{2}$/);
  });

  it('should return null for private IPs', () => {
    expect(geoip.lookup('127.0.0.1')).toBeNull();
    expect(geoip.lookup('10.0.0.1')).toBeNull();
    expect(geoip.lookup('192.168.1.1')).toBeNull();
  });

  it('should resolve IPv6 (Google DNS 2001:4860:4860::8888)', () => {
    const result = geoip.lookup('2001:4860:4860::8888');
    // IPv6 data may be less complete — just verify it doesn't crash
    // and returns either null or a valid country
    if (result) {
      expect(result.country).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('should have timezone data for major regions', () => {
    const ips = [
      { ip: '8.8.8.8', region: 'Americas' },
      { ip: '185.12.64.1', region: 'Europe' },       // DE
      { ip: '203.208.60.1', region: 'Asia-Pacific' }, // CN
    ];

    for (const { ip, region } of ips) {
      const result = geoip.lookup(ip);
      expect(result).not.toBeNull();
      expect(result!.timezone).toBeDefined();
      expect(result!.timezone.length).toBeGreaterThanOrEqual(5); // e.g. "UTC" wouldn't pass, but "Asia/Tokyo" would
    }
  });
});
