import 'dotenv/config';
import { Server as HttpServer } from 'http';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import {
  BadRequestException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { Server } from 'socket.io';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { validateEnv } from './config/env.schema';
import { AllExceptionsFilter } from './common/http-exception.filter';
import './socket/socket.types';
import { AuthService } from './auth/auth.service';

type ValidationIssue = {
  field: string;
  message: string;
};

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

async function bootstrap() {
  validateEnv();

  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const authService = app.get(AuthService);

  if (config.trustProxy) {
    const expressApp = app.getHttpAdapter().getInstance() as {
      set: (key: string, value: string | number | boolean) => void;
    };
    let proxyValue: string | number | boolean = config.trustProxy;
    if (config.trustProxy === 'true') {
      proxyValue = true;
    } else if (config.trustProxy === 'false') {
      proxyValue = false;
    } else if (/^\d+$/.test(config.trustProxy)) {
      proxyValue = parseInt(config.trustProxy, 10);
    }
    expressApp.set('trust proxy', proxyValue);
  }

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
      contentSecurityPolicy: process.env.NODE_ENV === 'production',
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  const corsOrigins = config.corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (config.isProduction && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGIN must be set in production');
  }

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key', 'X-Analytics-Key'],
    exposedHeaders: ['Content-Disposition'],
  });

  const allowedOrigins =
    corsOrigins.length > 0
      ? new Set(corsOrigins)
      : new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
  const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  // Basic CSRF protection for cookie-authenticated mutation requests.
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

  await app.listen(config.port);

  // Attach Socket.IO to the same HTTP server (for real-time review updates)
  const httpServer = app.getHttpServer() as HttpServer;
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin:
        corsOrigins.length > 0
          ? corsOrigins
          : ['http://localhost:3000', 'http://127.0.0.1:3000'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.on('connection', async (socket) => {
    void socket.join('reviews');

    const cookieHeader = socket.handshake.headers.cookie;
    const token = authService.getSessionTokenFromRequest({
      headers: { cookie: cookieHeader },
      cookies: {},
    } as Request);
    const user = await authService.getSessionFromToken(token);
    if (user?.id) {
      void socket.join(`user:${user.id}`);
    }
  });

  globalThis.__socketIO = io;
}
bootstrap().catch((error: unknown) => {
  console.error('Failed to bootstrap application', error);
  process.exit(1);
});
