import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    PORT: z
      .string()
      .optional()
      .transform((v) => (v ? parseInt(v, 10) : 8000)),
    JWT_SECRET: z.string().optional(),
    CORS_ORIGIN: z.string().optional(),
    /** Admin login: email (must match exactly). */
    ADMIN_EMAIL: z.string().optional(),
    /** Admin login: bcrypt hash of password. Generate with: node -e "require('bcryptjs').hash('yourpassword', 10).then(h=>console.log(h))" */
    ADMIN_PASSWORD_HASH: z.string().optional(),
    TRUST_PROXY: z.string().optional(),
    SENTRY_DSN: z.string().url().optional(),
    SENTRY_RELEASE: z.string().optional(),
    SENTRY_TRACES_SAMPLE_RATE: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v.trim() === '') {
          return 0.1;
        }
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new Error('SENTRY_TRACES_SAMPLE_RATE must be between 0 and 1');
        }
        return parsed;
      }),
  })
  .refine(
    (data) => {
      if (data.NODE_ENV === 'production') {
        return !!data.JWT_SECRET && data.JWT_SECRET.length >= 32;
      }
      return true;
    },
    {
      message:
        'JWT_SECRET must be set and at least 32 characters in production',
      path: ['JWT_SECRET'],
    },
  );

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(): EnvConfig {
  const parsed = envSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    JWT_SECRET: process.env.JWT_SECRET,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH,
    TRUST_PROXY: process.env.TRUST_PROXY,
    SENTRY_DSN: process.env.SENTRY_DSN,
    SENTRY_RELEASE: process.env.SENTRY_RELEASE,
    SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE,
  });

  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }

  return parsed.data;
}
