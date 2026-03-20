import nock from 'nock';

export default async function globalTeardown() {
  nock.cleanAll();
  nock.enableNetConnect();

  // Disconnect singleton clients to prevent open handles
  // (import dynamically to avoid side effects if globalSetup didn't run)
  try {
    const { disconnectTestClients } = await import('./test-db.utils');
    await disconnectTestClients();
  } catch {
    // Ignore — globalSetup may not have created clients
  }

  await (globalThis as any).__TEST_PG_CONTAINER__?.stop();
  await (globalThis as any).__TEST_REDIS_CONTAINER__?.stop();
}
