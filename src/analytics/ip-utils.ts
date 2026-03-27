import { isIP } from 'node:net';
import type { Request } from 'express';

/**
 * Extract a single string value from a request header.
 * Returns empty string if the header is absent or not a string/array.
 */
export function firstHeader(req: Request, name: string): string {
  const value = req.headers[name];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && value[0]) return value[0].trim();
  return '';
}

/**
 * Clean an IP string: strip ports, brackets, IPv4-mapped IPv6 prefixes, and zone IDs.
 * Returns a valid IP or empty string.
 */
export function normalizeIp(candidate: string): string {
  const ip = (candidate || '').trim();
  if (!ip) return '';

  // Bracketed IPv6 with optional port: [2001:db8::1]:443
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed?.[1]) {
    const clean = bracketed[1].replace(/^::ffff:/i, '').split('%')[0];
    return isIP(clean) ? clean : '';
  }

  // IPv4 with port: 1.2.3.4:1234
  const ipv4WithPort = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort?.[1]) return isIP(ipv4WithPort[1]) ? ipv4WithPort[1] : '';

  const clean = ip.replace(/^::ffff:/i, '').split('%')[0];
  return isIP(clean) ? clean : '';
}

/**
 * Returns true for loopback, RFC 1918, link-local, and ULA IPv6 addresses.
 */
export function isPrivateOrLocalIp(ip: string): boolean {
  if (!ip || ip === '::1') return true;
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  const v6 = ip.toLowerCase();
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
  if (v6.startsWith('fe80:')) return true;
  return false;
}

/**
 * From a list of raw IP strings, return the first public IP or fall back to the first valid one.
 */
export function pickBestIp(rawValues: string[]): string {
  const normalized = rawValues.map(normalizeIp).filter(Boolean);
  const firstPublic = normalized.find((ip) => !isPrivateOrLocalIp(ip));
  return firstPublic || normalized[0] || '';
}

/**
 * Parse RFC 7239 `Forwarded:` header into an array of IP strings.
 * Example: `Forwarded: for=203.0.113.10;proto=https, for="[2001:db8::1]"`
 */
export function parseForwardedHeader(value: string): string[] {
  return value
    .split(',')
    .map((part) => {
      const match = part.match(/for=("?\[?[a-fA-F0-9:.%]+\]?"?)/i);
      if (!match?.[1]) return '';
      return match[1].replace(/^"|"$|^'|'$/g, '');
    })
    .filter(Boolean);
}

/**
 * Resolve the real client IP from a request by checking CDN headers,
 * X-Forwarded-For, RFC 7239 Forwarded header, then socket remote address.
 */
export function getClientIp(req: Request): string {
  const directHeaders = [
    'cf-connecting-ip',
    'x-real-ip',
    'x-client-ip',
    'true-client-ip',
    'fastly-client-ip',
  ];
  for (const header of directHeaders) {
    const ip = normalizeIp(firstHeader(req, header));
    if (ip) return ip;
  }

  const forwardedHeaders = ['x-forwarded-for', 'x-vercel-forwarded-for'];
  for (const header of forwardedHeaders) {
    const value = firstHeader(req, header);
    if (!value) continue;
    const best = pickBestIp(
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part && part.toLowerCase() !== 'unknown'),
    );
    if (best) return best;
  }

  const forwarded = firstHeader(req, 'forwarded');
  if (forwarded) {
    const best = pickBestIp(parseForwardedHeader(forwarded));
    if (best) return best;
  }

  return normalizeIp(req.socket?.remoteAddress || req.ip || '');
}

/**
 * Extract a two-letter country code from CDN/edge headers.
 * Returns undefined if no valid code is found.
 */
export function getCountryHint(req: Request): string | undefined {
  const headerNames = [
    'cf-ipcountry',
    'x-vercel-ip-country',
    'cloudfront-viewer-country',
    'x-appengine-country',
    'x-country-code',
  ];
  for (const header of headerNames) {
    const value = firstHeader(req, header).toUpperCase();
    if (/^[A-Z]{2}$/.test(value)) return value;
  }
  return undefined;
}
