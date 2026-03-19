import { ZodError } from 'zod';
import { handleError, NotFoundError } from './errors';

describe('handleError', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return generic message for plain Error instances', () => {
    const result = handleError(
      new Error('Prisma: connection refused at 10.0.0.5:5432'),
    );

    expect(result.statusCode).toBe(500);
    expect(result.message).toBe('Internal server error');
    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.message).not.toContain('Prisma');
    expect(result.message).not.toContain('5432');
  });

  it('should log the real error message for plain Error instances', () => {
    const error = new Error('Prisma: connection refused at 10.0.0.5:5432');
    handleError(error);

    expect(console.error).toHaveBeenCalledWith(
      '[UnhandledError]',
      error.message,
      error.stack,
    );
  });

  it('should preserve ZodError validation messages', () => {
    const zodError = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        path: ['email'],
        message: 'Expected string, received number',
      } as any,
    ]);

    const result = handleError(zodError);

    expect(result.statusCode).toBe(400);
    expect(result.message).toBe('Expected string, received number');
    expect(result.code).toBe('VALIDATION_ERROR');
  });

  it('should preserve NotFoundError messages', () => {
    const result = handleError(new NotFoundError('Company not found'));

    expect(result.statusCode).toBe(404);
    expect(result.message).toBe('Company not found');
    expect(result.code).toBe('NOT_FOUND');
  });

  it('should return generic message for unknown error types', () => {
    const result = handleError('something unexpected');

    expect(result.statusCode).toBe(500);
    expect(result.message).toBe('Internal server error');
    expect(result.code).toBe('UNKNOWN_ERROR');
  });

  it('should log unknown error types', () => {
    handleError({ weird: 'object' });

    expect(console.error).toHaveBeenCalledWith('[UnknownError]', {
      weird: 'object',
    });
  });
});
