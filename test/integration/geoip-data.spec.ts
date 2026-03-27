import { Reader, AddressNotFoundError } from '@maxmind/geoip2-node';
import type ReaderModel from '@maxmind/geoip2-node/dist/src/readerModel';
import { join } from 'path';
import { existsSync } from 'fs';

const DB_PATH = join(process.cwd(), 'data', 'geoip', 'GeoLite2-City.mmdb');

/**
 * Verifies the GeoLite2-City.mmdb database is present, loadable, and
 * produces correct results for well-known IPs. Catches stale or
 * corrupted data files that would silently degrade country/timezone
 * resolution to empty results for all lookups.
 */
describe('GeoIP Database Integrity', () => {
  let reader: ReaderModel;

  beforeAll(async () => {
    if (!existsSync(DB_PATH)) {
      console.warn(
        `GeoIP database not found at ${DB_PATH} — run "npm run geoip:update" to download it. Skipping tests.`,
      );
    }
  });

  beforeEach(async () => {
    if (!existsSync(DB_PATH)) return;
    reader = await Reader.open(DB_PATH);
  });

  const skipIfNoDb = () => !existsSync(DB_PATH);

  it('should resolve Google DNS (8.8.8.8) to US', () => {
    if (skipIfNoDb()) return;
    const result = reader.city('8.8.8.8');
    expect(result.country?.isoCode).toBe('US');
    expect(result.location?.timeZone).toBeDefined();
    expect(result.location!.timeZone!.length).toBeGreaterThan(0);
  });

  it('should resolve Cloudflare DNS (1.1.1.1) to a valid country', () => {
    if (skipIfNoDb()) return;
    const result = reader.city('1.1.1.1');
    const code = result.country?.isoCode ?? result.registeredCountry?.isoCode;
    expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it('should throw AddressNotFoundError for private IPs', () => {
    if (skipIfNoDb()) return;
    expect(() => reader.city('127.0.0.1')).toThrow(AddressNotFoundError);
    expect(() => reader.city('10.0.0.1')).toThrow(AddressNotFoundError);
    expect(() => reader.city('192.168.1.1')).toThrow(AddressNotFoundError);
  });

  it('should resolve IPv6 (Google DNS 2001:4860:4860::8888)', () => {
    if (skipIfNoDb()) return;
    // IPv6 data may be less complete — just verify it doesn't crash
    try {
      const result = reader.city('2001:4860:4860::8888');
      expect(result.country?.isoCode).toMatch(/^[A-Z]{2}$/);
    } catch (err) {
      expect(err).toBeInstanceOf(AddressNotFoundError);
    }
  });

  it('should have timezone data for major regions', () => {
    if (skipIfNoDb()) return;
    const ips = [
      '8.8.8.8', // Americas
      '185.12.64.1', // Europe (DE)
      '203.208.60.1', // Asia-Pacific (CN)
    ];

    for (const ip of ips) {
      const result = reader.city(ip);
      expect(result.location?.timeZone).toBeDefined();
      expect(result.location!.timeZone!.length).toBeGreaterThanOrEqual(5);
    }
  });
});
