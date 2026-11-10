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

// ---------- 2026-11-10：自有回合不重建镜像连接 ----------
//
// 以前每轮都 stopObserver → runTurn 开新连接 → startObserver 再开一条；
// 单会话 89 次启动，DSH 重启期尤其容易撞上 1006。现在改成暂停：连接保持，
// 只丢输出（游标照常前进，恢复后不回放）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 5000, what = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${what}`);
};

test('observer: 自有回合期间连接保留（不 stop/start）', async (t) => {
  const mock = await startMockDsh((ws, streamId) => {
    const send = (value) => ws.send(JSON.stringify({ type: 'item', streamId, value }));
    const now = Date.now();
    send({ type: 'event', event: { type: 'user/message', seq: 20, time: now,
      data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } } });
    send({ type: 'event', event: { type: 'turn/start', seq: 21, time: now, data: { turn: 5 } } });
    send({ type: 'event', event: { type: 'assistant/message', seq: 22, time: now,
      data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } } } });
    send({ type: 'event', event: { type: 'turn/end', seq: 23, time: now,
      data: { turn: 5, reason: { kind: 'completed' } } } });
  }, { sessions: [{ sessionId: 'mock-session' }] });
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
  await until(() => mock.connections() >= 1, 5000, 'observer connection');
  const before = mock.connections();

  await conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: { clientMessageId: 'c1', delivery: 'auto',
      input: { type: 'message', content: [{ type: 'text', text: 'hi' }] } },
  });
  await waitFor(events, (e) => e.type === 'session.prompt_result' && e.clientMessageId === 'c1');
  await sleep(150); // 给 finally 里的恢复逻辑一点时间

  assert.equal(mock.connections(), before + 1,
    `自有回合只应新增 runTurn 那一条连接（之前 ${before}，现在 ${mock.connections()}）`);

  // 回合结束后镜像恢复：外部事件仍能进来
  const now = Date.now();
  await until(() => mock.send({ type: 'event', event: { type: 'turn/start', seq: 30, time: now, data: { turn: 6 } } }),
    5000, 'observer resumed');
  await waitFor(events, (e) => e.type === 'session.turn' && e.turnId === 'dsh-ext-6');

  await conn.send({ type: 'session.close', requestId: 'r9', sessionId: 'p1' });
});

// ---------- 2026-11-10：外部斜杠命令也镜像 ----------
//
// DSH 桌面版里跑 /compact，Paseo 之前完全看不到；现在 command/run + command/done
// 会分别变成一条「用户命令」和一条「命令回执」。

test('observer: 外部执行的斜杠命令镜像成时间线', async (t) => {
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
  await until(() => mock.connections() >= 1, 5000, 'observer connection');

  const now = Date.now();
  await until(() => mock.send({ type: 'event', event: { type: 'command/run', seq: 40, time: now,
    data: { commandId: 'cmd-x', name: 'compact', args: '', source: { kind: 'user' } } } }), 5000, 'command/run');
  await until(() => mock.send({ type: 'event', event: { type: 'command/done', seq: 41, time: now,
    data: { commandId: 'cmd-x', kind: 'success', text: 'Compacted 3 items.' } } }), 5000, 'command/done');

  const done = await waitFor(events, (e) => e.type === 'timeline.item' && e.item.id === 'cmd-done-cmd-x');
  assert.equal(done.item.text, 'Compacted 3 items.');
  const run = events.find((e) => e.type === 'timeline.item' && e.item.id === 'cmd-run-cmd-x');
  assert.ok(run, 'command/run 也要进时间线');
  assert.equal(run.item.type, 'user_message');
  assert.equal(run.item.text, '/compact');

  await conn.send({ type: 'session.close', requestId: 'r9', sessionId: 'p1' });
});
