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
