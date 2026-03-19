import { ConfigService } from './config.service';

describe('ConfigService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Ensure non-production defaults
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.PORT;
    delete process.env.CORS_ORIGIN;
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD_HASH;
    delete process.env.TRUST_PROXY;
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  function createService(): ConfigService {
    const svc = new ConfigService();
    svc.onModuleInit();
    return svc;
  }

  it('should return nodeEnv from env', () => {
    expect(createService().nodeEnv).toBe('test');
  });

  it('should default port to 8000', () => {
    expect(createService().port).toBe(8000);
  });

  it('should parse PORT from env', () => {
    process.env.PORT = '3000';
    expect(createService().port).toBe(3000);
  });

  it('should return dev fallback for jwtSecret in non-production', () => {
    expect(createService().jwtSecret).toBe('dev-secret-not-for-production');
  });

  it('should return actual JWT_SECRET when set', () => {
    process.env.JWT_SECRET = 'my-test-secret';
    expect(createService().jwtSecret).toBe('my-test-secret');
  });

  it('should throw for short JWT_SECRET in production (validateEnv rejects)', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'short';
    // Zod refinement rejects before ConfigService getter is reached
    expect(() => createService()).toThrow('Invalid environment');
  });

  it('should throw for missing JWT_SECRET in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => createService()).toThrow('Invalid environment');
  });

  it('should return isProduction correctly', () => {
    expect(createService().isProduction).toBe(false);
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a'.repeat(32);
    expect(createService().isProduction).toBe(true);
  });

  it('should return corsOrigin', () => {
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    expect(createService().corsOrigin).toBe('http://localhost:3000');
  });

  it('should return adminEmail and adminPasswordHash', () => {
    process.env.ADMIN_EMAIL = 'admin@test.com';
    process.env.ADMIN_PASSWORD_HASH = '$2a$10$hash';
    const svc = createService();
    expect(svc.adminEmail).toBe('admin@test.com');
    expect(svc.adminPasswordHash).toBe('$2a$10$hash');
  });

  it('should return trustProxy', () => {
    process.env.TRUST_PROXY = '1';
    expect(createService().trustProxy).toBe('1');
  });
});
