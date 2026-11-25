import test from 'node:test';
import assert from 'node:assert/strict';
import { rpc, probeDsh } from '../../server/dsh-client.ts';
import { clearDshEndpointCache } from '../../server/dsh-endpoint.mjs';

// 端点必须来自 env：否则 getDshEndpoint 会去扫本机日志，CI（无 DSH）直接走
// `legacy-fallback` 分支返回 unavailable，probeDsh 的 200 用例永远失败。
// 2026-11-25：CI（Linux，Node 22/24）一直红在这条上。
process.env.DSH_BASE = 'http://127.0.0.1:9';
process.env.DSH_MUX = 'ws://127.0.0.1:9';
process.env.DSH_COOKIE = 'dsh-auth-test';
clearDshEndpointCache();

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
