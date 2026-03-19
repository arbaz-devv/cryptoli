import nock from 'nock';

export default async function globalTeardown() {
  nock.cleanAll();
  nock.enableNetConnect();

  await (globalThis as any).__TEST_PG_CONTAINER__?.stop();
  await (globalThis as any).__TEST_REDIS_CONTAINER__?.stop();
}
