import type { Request, Response } from 'express';

export interface EdgeCachePolicy {
  browserMaxAge?: number;
  edgeMaxAge: number;
  staleWhileRevalidate?: number;
}

const AUTH_COOKIE_HINTS = ['session', 'auth', 'token', 'jwt'];

function mergeVaryValues(currentValue: string | string[] | number | undefined): string {
  const values = new Set<string>();

  const normalized = Array.isArray(currentValue)
    ? currentValue.join(',')
    : typeof currentValue === 'number'
      ? String(currentValue)
      : currentValue ?? '';

  for (const value of normalized.split(',')) {
    const trimmed = value.trim();
    if (trimmed) values.add(trimmed);
  }

  values.add('Accept-Encoding');
  values.add('Authorization');
  values.add('Cookie');

  return Array.from(values).join(', ');
}

function formatPublicCacheControl(policy: EdgeCachePolicy): string {
  const parts = [
    'public',
    `max-age=${policy.browserMaxAge ?? 0}`,
    `s-maxage=${policy.edgeMaxAge}`,
  ];

  if ((policy.staleWhileRevalidate ?? 0) > 0) {
    parts.push(`stale-while-revalidate=${policy.staleWhileRevalidate}`);
  }

  return parts.join(', ');
}

function requestHasAuthContext(req: Request & { user?: unknown | null }): boolean {
  if (req.user) return true;

  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.trim()) {
    return true;
  }

  const cookieHeader = req.headers.cookie ?? '';
  if (!cookieHeader.trim()) return false;

  return cookieHeader.split(';').some((entry) => {
    const name = entry.split('=')[0]?.trim().toLowerCase() ?? '';
    return AUTH_COOKIE_HINTS.some((hint) => name.includes(hint));
  });
}

function setSharedCacheHeaders(response: Response): void {
  response.setHeader('Vary', mergeVaryValues(response.getHeader('Vary')));
}

export function applyPublicEdgeCache(response: Response, policy: EdgeCachePolicy): void {
  setSharedCacheHeaders(response);
  response.setHeader('Cache-Control', formatPublicCacheControl(policy));
}

export function applyAnonymousEdgeCache(
  req: Request & { user?: unknown | null },
  response: Response,
  policy: EdgeCachePolicy,
): void {
  setSharedCacheHeaders(response);

  if (requestHasAuthContext(req)) {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return;
  }

  response.setHeader('Cache-Control', formatPublicCacheControl(policy));
}
