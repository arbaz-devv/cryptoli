import { validateEnv } from './env.schema';

describe('validateEnv', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
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

  it('should parse valid minimal env', () => {
    const config = validateEnv();
    expect(config.NODE_ENV).toBe('test');
    expect(config.PORT).toBe(8000); // default
  });

  it('should parse PORT as number', () => {
    process.env.PORT = '3000';
    expect(validateEnv().PORT).toBe(3000);
  });

  it('should default NODE_ENV to development when not set', () => {
    delete process.env.NODE_ENV;
    expect(validateEnv().NODE_ENV).toBe('development');
  });

  it('should reject invalid NODE_ENV', () => {
    process.env.NODE_ENV = 'staging';
    expect(() => validateEnv()).toThrow('Invalid environment');
  });

  it('should require JWT_SECRET >= 32 chars in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'short';
    expect(() => validateEnv()).toThrow('JWT_SECRET');
  });

  it('should accept valid production env', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a'.repeat(32);
    const config = validateEnv();
    expect(config.NODE_ENV).toBe('production');
    expect(config.JWT_SECRET).toBe('a'.repeat(32));
  });

  it('should pass through optional fields', () => {
    process.env.ADMIN_EMAIL = 'admin@test.com';
    process.env.TRUST_PROXY = 'true';
    const config = validateEnv();
    expect(config.ADMIN_EMAIL).toBe('admin@test.com');
    expect(config.TRUST_PROXY).toBe('true');
  });
});
