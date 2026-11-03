import test from 'node:test';
import assert from 'node:assert/strict';
import { rpc, probeDsh } from '../../server/dsh-client.ts';

const realFetch = globalThis.fetch;

test('client-1: non-JSON upstream error becomes readable', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response('DSH 上游不可达：connect ECONNREFUSED', { status: 502 });
  await assert.rejects(
    () => rpc('session/list'),
    /HTTP 502 DSH 上游不可达/,
  );
});

test('client-2: probeDsh reports unavailable on 5xx', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response('', { status: 502 });
  const r = await probeDsh(100);
  assert.equal(r.ok, false);
  assert.match(String(r.diagnostic), /502/);
});

test('client-3: probeDsh reports available on 200', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response('ok', { status: 200 });
  const r = await probeDsh(100);
  assert.equal(r.ok, true);
});
