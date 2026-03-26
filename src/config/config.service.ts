import { Injectable, OnModuleInit } from '@nestjs/common';
import { validateEnv, type EnvConfig } from './env.schema';

@Injectable()
export class ConfigService implements OnModuleInit {
  private config: EnvConfig | null = null;

  onModuleInit() {
    this.config = validateEnv();
  }

  private getOrThrow(): EnvConfig {
    if (!this.config) {
      this.config = validateEnv();
    }
    return this.config;
  }

  get nodeEnv(): string {
    return this.getOrThrow().NODE_ENV;
  }

  get port(): number {
    return this.getOrThrow().PORT ?? 8000;
  }

  /** JWT secret for signing session tokens. In production must be set via env (32+ chars). */
  get jwtSecret(): string {
    const env = this.getOrThrow();
    if (env.NODE_ENV === 'production') {
      if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
        throw new Error(
          'JWT_SECRET is required and must be at least 32 characters in production',
        );
      }
      return env.JWT_SECRET;
    }
    return env.JWT_SECRET ?? 'dev-secret-not-for-production';
  }

  get corsOrigin(): string {
    return this.getOrThrow().CORS_ORIGIN ?? '';
  }

  get adminEmail(): string | undefined {
    return this.getOrThrow().ADMIN_EMAIL;
  }

  get adminPasswordHash(): string | undefined {
    return this.getOrThrow().ADMIN_PASSWORD_HASH;
  }

  get isProduction(): boolean {
    return this.getOrThrow().NODE_ENV === 'production';
  }

  get trustProxy(): string | undefined {
    return this.getOrThrow().TRUST_PROXY;
  }

  get sentryDsn(): string | undefined {
    return this.getOrThrow().SENTRY_DSN;
  }

  get sentryRelease(): string | undefined {
    return this.getOrThrow().SENTRY_RELEASE;
  }

  get sentryTracesSampleRate(): number {
    return this.getOrThrow().SENTRY_TRACES_SAMPLE_RATE ?? 0.1;
  }
}
