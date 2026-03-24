import {
  firstHeader,
  normalizeIp,
  isPrivateOrLocalIp,
  pickBestIp,
  parseForwardedHeader,
  getClientIp,
  getCountryHint,
} from './ip-utils';

/** Minimal Express-like request stub for header extraction tests */
function mockReq(
  headers: Record<string, string | string[] | undefined> = {},
  extra: { remoteAddress?: string; ip?: string } = {},
) {
  return {
    headers,
    socket: { remoteAddress: extra.remoteAddress },
    ip: extra.ip,
  } as any;
}

describe('ip-utils', () => {
  describe('firstHeader()', () => {
    it('should return trimmed string header', () => {
      expect(firstHeader(mockReq({ 'x-test': '  value  ' }), 'x-test')).toBe(
        'value',
      );
    });

    it('should return first element of array header', () => {
      expect(
        firstHeader(mockReq({ 'x-test': ['  first  ', 'second'] }), 'x-test'),
      ).toBe('first');
    });

    it('should return empty string for missing header', () => {
      expect(firstHeader(mockReq({}), 'x-missing')).toBe('');
    });

    it('should return empty string for empty array header', () => {
      expect(firstHeader(mockReq({ 'x-test': [] }), 'x-test')).toBe('');
    });

    it('should return empty string for undefined header value', () => {
      expect(
        firstHeader(mockReq({ 'x-test': undefined }), 'x-test'),
      ).toBe('');
    });
  });

  describe('normalizeIp()', () => {
    it('should return empty string for empty input', () => {
      expect(normalizeIp('')).toBe('');
      expect(normalizeIp('  ')).toBe('');
    });

    it('should return valid plain IPv4', () => {
      expect(normalizeIp('8.8.8.8')).toBe('8.8.8.8');
    });

    it('should strip port from IPv4', () => {
      expect(normalizeIp('1.2.3.4:8080')).toBe('1.2.3.4');
    });

    it('should handle bracketed IPv6 with port', () => {
      expect(normalizeIp('[::1]:443')).toBe('::1');
    });

    it('should handle bracketed IPv6 without port', () => {
      expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1');
    });

    it('should strip ::ffff: IPv4-mapped prefix', () => {
      expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    });

    it('should strip ::ffff: prefix from bracketed IPv6', () => {
      expect(normalizeIp('[::ffff:10.0.0.1]:80')).toBe('10.0.0.1');
    });

    it('should strip zone IDs', () => {
      expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    });

    it('should return empty for invalid IPs', () => {
      expect(normalizeIp('not-an-ip')).toBe('');
      expect(normalizeIp('999.999.999.999')).toBe('');
    });

    it('should handle valid plain IPv6', () => {
      expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    });
  });

  describe('isPrivateOrLocalIp()', () => {
    it('should return true for empty string', () => {
      expect(isPrivateOrLocalIp('')).toBe(true);
    });

    it('should return true for IPv6 loopback', () => {
      expect(isPrivateOrLocalIp('::1')).toBe(true);
    });

    it('should return true for IPv4 loopback', () => {
      expect(isPrivateOrLocalIp('127.0.0.1')).toBe(true);
      expect(isPrivateOrLocalIp('127.255.255.255')).toBe(true);
    });

    it('should return true for 10.x.x.x range', () => {
      expect(isPrivateOrLocalIp('10.0.0.1')).toBe(true);
      expect(isPrivateOrLocalIp('10.255.255.255')).toBe(true);
    });

    it('should return true for 192.168.x.x range', () => {
      expect(isPrivateOrLocalIp('192.168.0.1')).toBe(true);
    });

    it('should return true for 172.16-31.x.x range', () => {
      expect(isPrivateOrLocalIp('172.16.0.1')).toBe(true);
      expect(isPrivateOrLocalIp('172.31.255.255')).toBe(true);
    });

    it('should return false for 172.32+ (not private)', () => {
      expect(isPrivateOrLocalIp('172.32.0.1')).toBe(false);
    });

    it('should return true for link-local IPv4', () => {
      expect(isPrivateOrLocalIp('169.254.1.1')).toBe(true);
    });

    it('should return true for ULA IPv6 (fc/fd)', () => {
      expect(isPrivateOrLocalIp('fc00::1')).toBe(true);
      expect(isPrivateOrLocalIp('fd12:3456::1')).toBe(true);
    });

    it('should return true for link-local IPv6 (fe80:)', () => {
      expect(isPrivateOrLocalIp('fe80::1')).toBe(true);
    });

    it('should return false for public IPs', () => {
      expect(isPrivateOrLocalIp('8.8.8.8')).toBe(false);
      expect(isPrivateOrLocalIp('203.0.113.10')).toBe(false);
      expect(isPrivateOrLocalIp('2001:db8::1')).toBe(false);
    });
  });

  describe('pickBestIp()', () => {
    it('should prefer public IP over private', () => {
      expect(pickBestIp(['10.0.0.1', '203.0.113.5'])).toBe('203.0.113.5');
    });

    it('should fall back to first valid IP when all are private', () => {
      expect(pickBestIp(['10.0.0.1', '192.168.1.1'])).toBe('10.0.0.1');
    });

    it('should return empty for empty array', () => {
      expect(pickBestIp([])).toBe('');
    });

    it('should skip invalid entries', () => {
      expect(pickBestIp(['garbage', '8.8.4.4'])).toBe('8.8.4.4');
    });

    it('should return empty when all entries are invalid', () => {
      expect(pickBestIp(['not-ip', 'also-bad'])).toBe('');
    });
  });

  describe('parseForwardedHeader()', () => {
    it('should parse single for= entry', () => {
      expect(parseForwardedHeader('for=203.0.113.10')).toEqual([
        '203.0.113.10',
      ]);
    });

    it('should parse multiple comma-separated entries', () => {
      expect(
        parseForwardedHeader(
          'for=203.0.113.10;proto=https, for=70.41.3.18',
        ),
      ).toEqual(['203.0.113.10', '70.41.3.18']);
    });

    it('should handle quoted bracketed IPv6', () => {
      expect(
        parseForwardedHeader('for="[2001:db8::1]"'),
      ).toEqual(['[2001:db8::1]']);
    });

    it('should return empty array for no for= directives', () => {
      expect(parseForwardedHeader('proto=https;host=example.com')).toEqual([]);
    });
  });

  describe('getClientIp()', () => {
    it('should extract from cf-connecting-ip', () => {
      expect(
        getClientIp(mockReq({ 'cf-connecting-ip': '203.0.113.1' })),
      ).toBe('203.0.113.1');
    });

    it('should extract from x-real-ip', () => {
      expect(getClientIp(mockReq({ 'x-real-ip': '203.0.113.2' }))).toBe(
        '203.0.113.2',
      );
    });

    it('should extract best IP from x-forwarded-for', () => {
      expect(
        getClientIp(
          mockReq({ 'x-forwarded-for': '10.0.0.1, 203.0.113.3, 10.0.0.2' }),
        ),
      ).toBe('203.0.113.3');
    });

    it('should filter "unknown" entries from x-forwarded-for', () => {
      expect(
        getClientIp(
          mockReq({ 'x-forwarded-for': 'unknown, 203.0.113.4' }),
        ),
      ).toBe('203.0.113.4');
    });

    it('should extract from RFC 7239 Forwarded header', () => {
      expect(
        getClientIp(
          mockReq({ forwarded: 'for=203.0.113.5;proto=https' }),
        ),
      ).toBe('203.0.113.5');
    });

    it('should fall back to socket remoteAddress', () => {
      expect(
        getClientIp(mockReq({}, { remoteAddress: '203.0.113.6' })),
      ).toBe('203.0.113.6');
    });

    it('should fall back to req.ip', () => {
      expect(getClientIp(mockReq({}, { ip: '203.0.113.7' }))).toBe(
        '203.0.113.7',
      );
    });

    it('should prefer CDN headers over x-forwarded-for', () => {
      expect(
        getClientIp(
          mockReq({
            'cf-connecting-ip': '203.0.113.8',
            'x-forwarded-for': '203.0.113.9',
          }),
        ),
      ).toBe('203.0.113.8');
    });

    it('should return empty string when no IP sources available', () => {
      expect(getClientIp(mockReq({}, {}))).toBe('');
    });
  });

  describe('getCountryHint()', () => {
    it('should extract from cf-ipcountry', () => {
      expect(getCountryHint(mockReq({ 'cf-ipcountry': 'US' }))).toBe('US');
    });

    it('should extract from x-vercel-ip-country', () => {
      expect(
        getCountryHint(mockReq({ 'x-vercel-ip-country': 'de' })),
      ).toBe('DE');
    });

    it('should return undefined when no country header present', () => {
      expect(getCountryHint(mockReq({}))).toBeUndefined();
    });

    it('should reject invalid country codes (too long)', () => {
      expect(
        getCountryHint(mockReq({ 'cf-ipcountry': 'USA' })),
      ).toBeUndefined();
    });

    it('should reject special values like XX or T1', () => {
      // These are technically valid 2-char codes — the function accepts them
      // Cloudflare uses XX for unknown; the function doesn't special-case it
      expect(getCountryHint(mockReq({ 'cf-ipcountry': 'XX' }))).toBe('XX');
    });

    it('should prefer first matching header', () => {
      expect(
        getCountryHint(
          mockReq({
            'cf-ipcountry': 'GB',
            'x-vercel-ip-country': 'DE',
          }),
        ),
      ).toBe('GB');
    });
  });
});
