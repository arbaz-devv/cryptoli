import nock from 'nock';
import { disconnectTestClients } from './test-db.utils';

export default async function globalTeardown() {
  nock.cleanAll();
  nock.enableNetConnect();

  // Disconnect singleton clients to prevent open handles
  try {
    await disconnectTestClients();
  } catch {
    // Ignore — clients may not have been created
  }

  await (globalThis as any).__TEST_PG_CONTAINER__?.stop();
  await (globalThis as any).__TEST_REDIS_CONTAINER__?.stop();
}
