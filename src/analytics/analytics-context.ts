/**
 * Request-scoped analytics context populated by AnalyticsInterceptor.
 * Controllers opt in via @UseInterceptors(AnalyticsInterceptor), then
 * access `req.analyticsCtx` to pass context to service-layer track() calls.
 */
export interface AnalyticsContext {
  ip: string;
  userAgent: string;
  country?: string;
  userId?: string;
}

/** Type-safe accessor for req.analyticsCtx set by AnalyticsInterceptor. */
export function getAnalyticsCtx(req: unknown): AnalyticsContext | undefined {
  const r = req as Record<string, unknown>;
  return r.analyticsCtx as AnalyticsContext | undefined;
}
