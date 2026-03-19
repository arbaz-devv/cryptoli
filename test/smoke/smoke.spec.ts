/**
 * Smoke tests — run against a live deployment.
 *
 * Requires the SMOKE_TEST_URL environment variable to be set (e.g.
 * https://api.example.com). All requests are read-only GETs; no data is
 * mutated. Total expected runtime is well under 2 seconds.
 *
 * Run with: npm run test:smoke
 */

const BASE_URL = process.env.SMOKE_TEST_URL;

if (!BASE_URL) {
  throw new Error(
    'SMOKE_TEST_URL environment variable is not set. ' +
      'Export it before running smoke tests: ' +
      'SMOKE_TEST_URL=https://api.example.com npm run test:smoke',
  );
}

// Strip any trailing slash so every path join is consistent.
const base = BASE_URL.replace(/\/$/, '');

async function get(path: string): Promise<Response> {
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

describe('Smoke tests', () => {
  it('GET / returns 200', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
  });

  it('GET /api/analytics/health returns 200', async () => {
    const res = await get('/api/analytics/health');
    expect(res.status).toBe(200);
  });

  it('GET /api/auth/me returns 200', async () => {
    const res = await get('/api/auth/me');
    expect(res.status).toBe(200);
  });

  it('GET /api/reviews?limit=1 returns 200', async () => {
    const res = await get('/api/reviews?limit=1');
    expect(res.status).toBe(200);
  });

  it('GET /api/companies?limit=1 returns 200', async () => {
    const res = await get('/api/companies?limit=1');
    expect(res.status).toBe(200);
  });
});
