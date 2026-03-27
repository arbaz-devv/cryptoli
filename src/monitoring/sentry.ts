import * as Sentry from '@sentry/nestjs';

type SentryInitOptions = {
  dsn?: string;
  environment: string;
  tracesSampleRate: number;
  release?: string;
};

let initialized = false;

export function initSentry(options: SentryInitOptions): void {
  if (initialized || !options.dsn) {
    return;
  }

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    tracesSampleRate: options.tracesSampleRate,
    release: options.release,
    enabled: options.environment !== 'test',
    sendDefaultPii: false,
  });

  initialized = true;
}

export { Sentry };
