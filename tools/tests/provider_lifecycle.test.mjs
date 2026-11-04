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
  const result = await waitFor(events,
    (e) => e.type === 'session.prompt_result' && e.result?.type === 'failed');
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
  await waitFor(events, () => events.filter((e) =>
    e.type === 'session.prompt_result' && e.result?.type === 'failed').length >= 2);
  const last = events.filter((e) => e.type === 'session.prompt_result' && e.result?.type === 'failed').at(-1);
  assert.equal(last.result.type, 'failed');
});

test('lifecycle: 外部运行的 DSH 会话 → 打开提示 + prompt 快速失败', async (t) => {
  const mock = await startMockDsh(() => {}, {
    sessions: [{ sessionId: 'mock-session', running: true }],
  });
  process.env.DSH_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.DSH_MUX = `ws://127.0.0.1:${mock.port}`;
  process.env.DSH_RUNNING_MODE = 'fail';
  t.after(() => { mock.close(); delete process.env.DSH_RUNNING_MODE; });

  const { createProvider } = await import('../../server/provider.ts');
  const conn = await createProvider().connect({});
  const events = [];
  conn.onEvent((e) => events.push(e));

  await conn.send({
    type: 'session.open', requestId: 'r1', sessionId: 'p1',
    config: { cwd: '/tmp' }, history: 'skip',
  });
  await waitFor(events, (e) => e.type === 'session.ready');
  const notice = events.find((e) => e.type === 'session.notice' && /正在运行/.test(e.notice?.description || ''));
  assert.ok(notice, 'running notice expected');

  await prompt(conn, 'p1');
  const failed = await waitFor(events, (e) => e.type === 'session.prompt_result');
  assert.equal(failed.result.type, 'failed');
  assert.equal(failed.result.error.code, 'dsh/busy');
  assert.ok(!mock.calls.some((c) => c.method === 'session/prompt'), 'must not queue a prompt');
});

test('lifecycle: run start is reported before a long turn ends', async (t) => {
  const mock = await startMockDsh((ws, streamId) => {
    const send = (value) => ws.send(JSON.stringify({ type: 'item', streamId, value }));
    const now = Date.now();
    send({ type: 'event', event: { type: 'user/message', seq: 1, time: now,
      data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } });
    send({ type: 'event', event: { type: 'turn/start', seq: 2, time: now, data: { turn: 7 } } });
    setTimeout(() => {
      send({ type: 'event', event: { type: 'turn/end', seq: 3, time: Date.now(),
        data: { turn: 7, reason: { kind: 'completed' } } } });
    }, 300);
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
  await waitFor(events, (e) => e.type === 'session.ready');

  await prompt(conn, 'p1');
  // Paseo 60s 内必须看到 prompt_result(turn)，否则长回合会被判「run did not start」
  const started = await waitFor(events,
    (e) => e.type === 'session.prompt_result' && e.result?.type === 'turn');
  assert.match(started.result.turnId, /^dsh-turn-/);
  assert.ok(!events.some((e) => e.type === 'session.turn' && e.state === 'completed'),
    'turn must still be running when the start result is emitted');

  const done = await waitFor(events, (e) => e.type === 'session.turn' && e.state === 'completed');
  assert.equal(done.turnId, started.result.turnId);
});

test('lifecycle: observer mirrors an external turn after open', async (t) => {
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

test('lifecycle: 外部运行的会话默认 steer 插入当前轮次', async (t) => {
  delete process.env.DSH_RUNNING_MODE;
  const mock = await startMockDsh((ws, streamId) => {
    const send = (value) => ws.send(JSON.stringify({ type: 'item', streamId, value }));
    const now = Date.now();
    // 模拟外部已运行中的轮次：没有 turn/start，只有 steer 的用户消息、assistant 和 turn/end
    send({ type: 'event', event: { type: 'user/message', seq: 1, time: now,
      data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } });
    send({ type: 'event', event: { type: 'assistant/message', seq: 2, time: now,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'steered-answer' }] } } } });
    send({ type: 'event', event: { type: 'turn/end', seq: 3, time: now,
      data: { turn: 1, reason: { kind: 'completed' } } } });
  }, {
    sessions: [{ sessionId: 'mock-session', running: true }],
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
  await waitFor(events, (e) => e.type === 'session.ready');

  await prompt(conn, 'p1');
  const result = await waitFor(events, (e) => e.type === 'session.prompt_result');
  assert.equal(result.result.type, 'steer');
  const finished = await waitFor(events,
    (e) => e.type === 'session.prompt_result' && e.result?.type === 'completed');
  assert.equal(finished.result.type, 'completed');
  assert.equal(mock.calls.find((c) => c.method === 'session/prompt')?.args.mode, 'steer');

  const started = events.find((e) => e.type === 'session.turn' && e.state === 'started');
  assert.ok(started?.turnId?.startsWith('dsh-steer-'), 'synthetic steer turn expected');
  assert.ok(events.some((e) => e.type === 'session.notice' && /插入当前轮次/.test(e.notice?.description || '')));
  const text = events.filter((e) => e.type === 'timeline.item' && e.item.type === 'assistant_message')
    .map((e) => e.item.text).join('');
  assert.equal(text, 'steered-answer');
});
