import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    public errors?: unknown,
  ) {
    super(400, message, 'VALIDATION_ERROR');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, message, 'NOT_FOUND');
  }
}

export function handleError(error: unknown): {
  statusCode: number;
  message: string;
  code?: string;
  errors?: unknown;
} {
  if (error instanceof ZodError) {
    const issues = error.issues;
    const errors = issues.map((err) => ({
      field: err.path.join('.'),
      message: err.message,
    }));
    const firstError = errors[0];
    return {
      statusCode: 400,
      message: firstError?.message || 'Validation failed',
      code: 'VALIDATION_ERROR',
      errors,
    };
  }

  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      message: error.message,
      code: error.code,
    };
  }

  if (error instanceof Error) {
    console.error('[UnhandledError]', error.message, error.stack);
    return {
      statusCode: 500,
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    };
  }

  console.error('[UnknownError]', error);
  return {
    statusCode: 500,
    message: 'Internal server error',
    code: 'UNKNOWN_ERROR',
  };
}
