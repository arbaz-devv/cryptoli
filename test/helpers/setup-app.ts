import { Test } from '@nestjs/testing';
import {
  INestApplication,
  BadRequestException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../../src/common/http-exception.filter';
import { getTestPrisma } from './test-db.utils';

type ValidationIssue = { field: string; message: string };

function collectValidationIssues(
  errors: ValidationError[],
  parentPath = '',
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const error of errors) {
    const fieldPath = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    const messages = error.constraints ? Object.values(error.constraints) : [];
    for (const message of messages) {
      issues.push({ field: fieldPath, message });
    }
    if (error.children && error.children.length > 0) {
      issues.push(...collectValidationIssues(error.children, fieldPath));
    }
  }
  return issues;
}

/**
 * Boots a real NestJS app with the same middleware as main.ts,
 * but overrides PrismaService to use the TestContainers instance.
 */
export async function setupTestApp(): Promise<{
  app: INestApplication;
  server: any;
}> {
  const testPrisma = getTestPrisma();

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(testPrisma)
    .compile();

  const app = moduleFixture.createNestApplication();

  // Replicate main.ts middleware stack
  app.use(
    compression({
      threshold: 1024,
      level: 6,
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      stopAtFirstError: false,
      validationError: { target: false, value: false },
      exceptionFactory: (errors: ValidationError[]) =>
        new BadRequestException({
          message: 'Validation failed',
          errors: collectValidationIssues(errors),
        }),
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  app.use(
    helmet({
      contentSecurityPolicy: false, // disabled in test
      crossOriginResourcePolicy: { policy: 'cross-origin' as const },
    }),
  );

  app.enableCors({
    origin: ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Admin-Key',
      'X-CSRF-Token',
      'X-Analytics-Key',
    ],
    exposedHeaders: ['Content-Disposition'],
  });

  // CSRF middleware — same logic as main.ts
  const allowedOrigins = new Set(['http://localhost:3000']);
  const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!unsafeMethods.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const cookieHeader = req.headers.cookie ?? '';
    const hasSessionCookie = /(?:^|;\s*)session=/.test(cookieHeader);
    if (!hasSessionCookie) {
      next();
      return;
    }

    const originHeader = req.headers.origin;
    const refererHeader = req.headers.referer;
    let requestOrigin = originHeader;

    if (!requestOrigin && refererHeader) {
      try {
        requestOrigin = new URL(refererHeader).origin;
      } catch {
        requestOrigin = undefined;
      }
    }

    if (!requestOrigin || !allowedOrigins.has(requestOrigin)) {
      res.status(403).json({ error: 'CSRF validation failed' });
      return;
    }

    next();
  });

  await app.init();

  return { app, server: app.getHttpServer() };
}

export async function teardownTestApp(app: INestApplication) {
  await app.close();
}
