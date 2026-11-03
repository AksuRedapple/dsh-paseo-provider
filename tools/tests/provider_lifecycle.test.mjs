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

const waitFor = async (events, pred, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for event');
};

const prompt = (conn, sessionId) => conn.send({
  type: 'session.prompt', sessionId,
  prompt: {
    clientMessageId: 'c1', delivery: 'auto',
    input: { type: 'message', content: [{ type: 'text', text: 'hello' }] },
  },
});

test('lifecycle: can_stop/interrupt/close on a running turn', async (t) => {
  const mock = await startMockDsh((ws, streamId) => {
    const send = (value) => ws.send(JSON.stringify({ type: 'item', streamId, value }));
    const now = Date.now();
    send({ type: 'event', event: { type: 'user/message', seq: 1, time: now,
      data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } });
    send({ type: 'event', event: { type: 'turn/start', seq: 2, time: now, data: { turn: 1 } } });
    send({ type: 'assistant-stream', frame: { type: 'start', turn: 1, step: 1 } });
    send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'partial' } } });
    // 不发送 turn/end：模拟长轮次，等待 interrupt/close
  });
  process.env.DSH_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.DSH_MUX = `ws://127.0.0.1:${mock.port}`;
  t.after(() => mock.close());

  const { createProvider } = await import('../../server/provider.ts');
  const conn = await createProvider().connect({});
  const events = [];
  conn.onEvent((e) => events.push(e));

  await conn.send({
    type: 'session.open', requestId: 'r1', sessionId: 'p1',
    config: { cwd: '/tmp' }, history: 'skip',
  });
  await prompt(conn, 'p1');
  await waitFor(events, (e) => e.type === 'session.turn' && e.state === 'started');

  await conn.send({ type: 'session.can_stop_runtime', requestId: 'r2', sessionId: 'p1' });
  const canStop = await waitFor(events, (e) => e.type === 'session.can_stop_runtime');
  assert.equal(canStop.canStop, true);

  await conn.send({ type: 'session.interrupt', requestId: 'r3', sessionId: 'p1' });
  const result = await waitFor(events, (e) => e.type === 'session.prompt_result');
  assert.equal(result.result.type, 'failed');
  assert.match(String(result.result.error?.message), /canceled/);

  await conn.send({ type: 'session.can_stop_runtime', requestId: 'r4', sessionId: 'p1' });
  const stopped = await waitFor(events,
    (e) => e.type === 'session.can_stop_runtime' && e.requestId === 'r4');
  assert.equal(stopped.canStop, false);

  await conn.send({
    type: 'session.open', requestId: 'r5', sessionId: 'p2',
    config: { cwd: '/tmp' }, history: 'skip',
  });
  await prompt(conn, 'p2');
  await waitFor(events, (e) => e.type === 'session.turn' && e.state === 'started' &&
    events.filter((x) => x.type === 'session.turn' && x.state === 'started').length >= 2);

  await conn.send({ type: 'session.close', requestId: 'r6', sessionId: 'p2' });
  const closed = await waitFor(events, (e) => e.type === 'session.closed');
  assert.equal(closed.sessionId, 'p2');
  await waitFor(events, () => events.filter((e) => e.type === 'session.prompt_result').length >= 2);
  const last = events.filter((e) => e.type === 'session.prompt_result').at(-1);
  assert.equal(last.result.type, 'failed');
});
