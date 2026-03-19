import {
  HttpException,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';

function mockHost(): { host: ArgumentsHost; response: any } {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should extract status and message from HttpException', () => {
    const { host, response } = mockHost();
    filter.catch(new NotFoundException('User not found'), host);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({ error: 'User not found' });
  });

  it('should handle BadRequestException with string message', () => {
    const { host, response } = mockHost();
    filter.catch(new BadRequestException('Invalid input'), host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ error: 'Invalid input' });
  });

  it('should handle UnauthorizedException', () => {
    const { host, response } = mockHost();
    filter.catch(new UnauthorizedException('Auth required'), host);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'Auth required' });
  });

  it('should pass through errors array from HttpException', () => {
    const { host, response } = mockHost();
    const exception = new BadRequestException({
      message: 'Validation failed',
      errors: [{ field: 'email', message: 'Invalid email' }],
    });

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Validation failed',
      errors: [{ field: 'email', message: 'Invalid email' }],
    });
  });

  it('should handle HttpException with array message (takes first)', () => {
    const { host, response } = mockHost();
    const exception = new BadRequestException({
      message: ['First error', 'Second error'],
    });

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ error: 'First error' });
  });

  it('should delegate non-HttpException to handleError and return sanitized 500', () => {
    const { host, response } = mockHost();
    filter.catch(new Error('DB connection failed'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Internal server error',
    });
    // Should NOT leak internal error details
    const jsonArg = response.json.mock.calls[0][0];
    expect(JSON.stringify(jsonArg)).not.toContain('DB connection');
  });

  it('should handle unknown error types', () => {
    const { host, response } = mockHost();
    filter.catch('string error', host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Internal server error',
    });
  });

  it('should handle plain HttpException without object body', () => {
    const { host, response } = mockHost();
    filter.catch(new HttpException('Simple error', 503), host);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({ error: 'Simple error' });
  });
});
