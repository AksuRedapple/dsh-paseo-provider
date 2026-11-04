/**
 * 只读实时镜像（observer）回归。
 *
 * 单独一个文件跑：observer 是长连接，和前面的 lifecycle 用例共享进程时，
 * 上一个用例残留的 observer 可能抢到新 mock 的连接（端口复用/延迟连接），
 * 导致事件发给了旧 provider 的 emit。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { startMockDsh } from './mock-dsh.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && extname(specifier) === '' && !String(context.parentURL || '').includes('/node_modules/')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const waitFor = async (events, pred, ms = 15000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for event');
};

test('observer: external turn is mirrored after open', async (t) => {
  const mock = await startMockDsh(() => {}, { sessions: [{ sessionId: 'mock-session' }] });
  process.env.DSH_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.DSH_MUX = `ws://127.0.0.1:${mock.port}`;
  t.after(() => mock.close());

  const { createProvider } = await import('../../server/provider.ts');
  const conn = await createProvider().connect({});
  const events = [];
  conn.onEvent((e) => events.push(e));

  await conn.send({
    type: 'session.open', requestId: 'r1', sessionId: 'p1',
    config: { cwd: '/tmp' },
    persistence: { version: 1, data: { sessionId: 'mock-session' } },
    history: 'skip',
  });
  await waitFor(events, (e) => e.type === 'session.ready');

  const send = async (value) => {
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      if (mock.send(value)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('observer not connected');
  };
  const now = Date.now();
  await send({ type: 'event', event: { type: 'turn/start', seq: 10, time: now, data: { turn: 9 } } });
  await waitFor(events, (e) => e.type === 'session.turn' && e.state === 'started' && e.turnId === 'dsh-ext-9');

  await send({ type: 'event', event: { type: 'user/message', seq: 11, time: now,
    data: { content: [{ type: 'text', text: 'external question' }], source: { kind: 'user' } } } });
  await send({ type: 'assistant-stream', frame: { type: 'start', turn: 9, step: 1 } });
  await send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'external answer' } } });
  await send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'finish' } } });
  await send({ type: 'event', event: { type: 'assistant/message', seq: 12, time: now,
    data: { turn: 9, step: 1, message: { content: [{ type: 'text', text: 'external answer' }] } } } });
  await send({ type: 'event', event: { type: 'turn/end', seq: 13, time: now,
    data: { turn: 9, reason: { kind: 'completed' } } } });

  const done = await waitFor(events, (e) => e.type === 'session.turn' && e.state === 'completed');
  assert.equal(done.turnId, 'dsh-ext-9');
  const items = events.filter((e) => e.type === 'timeline.item').map((e) => e.item);
  assert.ok(items.some((i) => i.type === 'user_message' && i.text === 'external question'));
  assert.ok(items.some((i) => i.type === 'assistant_message' && i.text === 'external answer'));
});
