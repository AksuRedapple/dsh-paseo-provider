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

  const done = await waitFor(events, (e) => e.type === 'session.turn' && e.state === 'completed', 15000);
  assert.equal(done.turnId, started.result.turnId);
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

// ---------- 2026-11-10：interrupt 后立刻发消息不再是 busy ----------
//
// 线上两次（11-07 15:57:42 / 15:58:54）：点「停止」马上补一句话，
// 上一轮的 abort→finally 还没跑完，就直接被判 session busy。

const promptWithId = (conn, sessionId, clientMessageId, text) => conn.send({
  type: 'session.prompt', sessionId,
  prompt: {
    clientMessageId, delivery: 'auto',
    input: { type: 'message', content: [{ type: 'text', text }] },
  },
});

test('lifecycle: interrupt 后立刻发消息不再误判 busy', async (t) => {
  let prompts = 0;
  const mock = await startMockDsh((ws, streamId) => {
    prompts++;
    const send = (value) => ws.send(JSON.stringify({ type: 'item', streamId, value }));
    const now = Date.now();
    if (prompts === 1) {
      // 长轮次：只开不收工，等 interrupt
      send({ type: 'event', event: { type: 'user/message', seq: 1, time: now,
        data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } });
      send({ type: 'event', event: { type: 'turn/start', seq: 2, time: now, data: { turn: 1 } } });
      return;
    }
    send({ type: 'event', event: { type: 'user/message', seq: 3, time: now,
      data: { content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } } } });
    send({ type: 'event', event: { type: 'turn/start', seq: 4, time: now, data: { turn: 2 } } });
    setTimeout(() => {
      send({ type: 'event', event: { type: 'turn/end', seq: 5, time: Date.now(),
        data: { turn: 2, reason: { kind: 'completed' } } } });
    }, 20);
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
  await promptWithId(conn, 'p1', 'm1', 'hello');
  await waitFor(events, (e) => e.type === 'session.turn' && e.state === 'started');

  await conn.send({ type: 'session.interrupt', requestId: 'r2', sessionId: 'p1' });
  // 关键：不等待任何事件，立刻补一句话（用户真实操作就是这个节奏）
  await promptWithId(conn, 'p1', 'm2', 'again');

  const second = await waitFor(events,
    (e) => e.type === 'session.prompt_result' && e.clientMessageId === 'm2');
  assert.notEqual(second.result.type, 'failed',
    `interrupt 后立刻发消息被判失败：${JSON.stringify(second.result)}`);
  assert.ok(second.result.turnId, '第二轮必须拿到 turnId');
  assert.ok(!events.some((e) => e.type === 'session.prompt_result' && e.result?.error?.code === 'dsh/busy'),
    '不得再出现 dsh/busy');

  // 观察者会长期跟随后台重连，收尾必须显式关会话，否则测试进程不退出
  await conn.send({ type: 'session.close', requestId: 'r3', sessionId: 'p1' });
});

// ---------- 2026-11-10：图片能力预检 ----------
//
// DSH 的 modelCatalog 没有能力位，只能从 session/attachment-invalid 反向学习；
// 学到之后同类请求要快速失败，而不是每轮都打到 DSH 才报错。

test('lifecycle: 不支持图片的模型 → 学一次，之后快速失败', async (t) => {
  const mock = await startMockDsh(() => {}, {
    promptError: { code: 'session/attachment-invalid', message: 'Model "mock-pro" does not support image input' },
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
    config: { cwd: '/tmp', model: 'prov-a::mock-pro' }, history: 'skip',
  });
  await waitFor(events, (e) => e.type === 'session.ready');

  const promptImage = (clientMessageId) => conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: {
      clientMessageId, delivery: 'auto',
      input: { type: 'message', content: [
        { type: 'text', text: '看下这张图' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ] },
    },
  });

  await promptImage('m1');
  const first = await waitFor(events, (e) => e.type === 'session.prompt_result' && e.clientMessageId === 'm1');
  assert.equal(first.result.type, 'failed');
  assert.equal(first.result.error.code, 'dsh/attachment', '第一次由 DSH 拒绝 → 转成可读错误');
  assert.match(first.result.error.message, /不支持|不接受/, '必须说清是图片能力问题');
  assert.equal(mock.calls.filter((c) => c.method === 'session/prompt').length, 1);

  await promptImage('m2');
  const second = await waitFor(events, (e) => e.type === 'session.prompt_result' && e.clientMessageId === 'm2');
  assert.equal(second.result.error.code, 'dsh/no-image-support', '第二次应在本地快速失败');
  assert.equal(mock.calls.filter((c) => c.method === 'session/prompt').length, 1, '不得再打 DSH');

  await conn.send({ type: 'session.close', requestId: 'r9', sessionId: 'p1' });
});

// ---------- 2026-11-10：selectModel 失败 → 刷新目录 ----------
//
// 真机两次 `session/model-unavailable`：Paseo 的模型列表里还有 DSH 已下架的 provider。
// 以前整条 configure 变成 request.failed，UI 还挂着坏模型。

test('lifecycle: selectModel 失败 → 保留当前模型并刷新 session.config', async (t) => {
  const mock = await startMockDsh(() => {}, {
    selectModelError: { code: 'session/model-unavailable', message: 'provider "ocgo" is not available' },
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
  const configsBefore = events.filter((e) => e.type === 'session.config').length;

  await conn.send({
    type: 'session.configure', requestId: 'r2', sessionId: 'p1',
    changes: { model: 'prov-a::mock-pro' },
  });

  const refreshed = await waitFor(events, (e) => e.type === 'session.config'
    && events.filter((x) => x.type === 'session.config').length > configsBefore);
  assert.ok(Array.isArray(refreshed.config.models) && refreshed.config.models.length > 0,
    '刷新后的 config 必须带模型列表');
  const notice = events.find((e) => e.type === 'session.notice' && /切换模型失败/.test(e.notice?.description || ''));
  assert.ok(notice, '必须有一条可读 notice');
  assert.ok(!events.some((e) => e.type === 'request.failed'), '不应把整条 configure 打成失败');
  assert.equal(mock.calls.filter((c) => c.method === 'session/selectModel').length, 1, '只尝试一次，不狂刷');

  await conn.send({ type: 'session.close', requestId: 'r9', sessionId: 'p1' });
});

// ---------- 2026-11-10：斜杠命令（/compact 等）接通 DSH commands/execute ----------
//
// 之前没声明 prompt.command：Paseo 把 "/compact" 当普通文本发给 DSH，看起来"没压缩"。

test('lifecycle: 斜杠命令走 commands/execute 而不是普通 prompt', async (t) => {
  const mock = await startMockDsh(() => {});
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

  const cmdEvent = await waitFor(events, (e) => e.type === 'session.commands');
  assert.ok(cmdEvent.commands.some((c) => c.name === 'compact'), '必须广播 compact 命令');
  const goal = cmdEvent.commands.find((c) => c.name === 'goal');
  assert.equal(goal.argumentHint, '[<objective>|clear]', 'argumentHint 来自 DSH input.hint');

  await conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: { clientMessageId: 'cmd-1', delivery: 'auto', input: { type: 'command', name: 'compact', arguments: '' } },
  });

  const done = await waitFor(events,
    (e) => e.type === 'session.prompt_result' && e.clientMessageId === 'cmd-1');
  assert.equal(done.result.type, 'completed');

  const call = mock.calls.find((c) => c.method === 'commands/execute');
  assert.ok(call, '必须调用 commands/execute');
  assert.equal(call.args.line, '/compact');
  assert.equal(call.args.agentId, 'mock-session');
  assert.ok(!mock.calls.some((c) => c.method === 'session/prompt'), '不得把命令当普通文本发给模型');

  const said = events.filter((e) => e.type === 'timeline.item' && e.item.type === 'assistant_message');
  assert.ok(said.some((e) => /No compactable history/.test(e.item.text)), '命令回执要进时间线');

  await conn.send({ type: 'session.close', requestId: 'r9', sessionId: 'p1' });
});

// ---------- 2026-11-10：上下文占用要跟着回合/压缩走 ----------
//
// 以前只在「回合成功结束」发一次 session.usage：面板看着延迟，abort/失败时干脆不动；
// 现在回合开始、每 3s（值变化时）、收工、命令执行后都会刷新，压缩事件还会给可见反馈。

test('lifecycle: 上下文占用随回合与 /compact 更新', async (t) => {
  const mock = await startMockDsh((ws, streamId) => {
    const send = (value) => ws.send(JSON.stringify({ type: 'item', streamId, value }));
    const now = Date.now();
    send({ type: 'event', event: { type: 'user/message', seq: 1, time: now,
      data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } } });
    send({ type: 'event', event: { type: 'turn/start', seq: 2, time: now, data: { turn: 1 } } });
    send({ type: 'event', event: { type: 'assistant/message', seq: 3, time: now,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } } } });
    send({ type: 'event', event: { type: 'turn/end', seq: 4, time: now,
      data: { turn: 1, reason: { kind: 'completed' } } } });
  }, { pressureTokens: 1000, contextWindow: 10000 });
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

  await conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: { clientMessageId: 'm1', delivery: 'auto',
      input: { type: 'message', content: [{ type: 'text', text: 'hi' }] } },
  });
  await waitFor(events, (e) => e.type === 'session.prompt_result' && e.clientMessageId === 'm1');

  const first = events.filter((e) => e.type === 'session.usage').at(-1);
  assert.ok(first, '回合期间必须发出 session.usage');
  assert.equal(first.usage.contextWindowUsedTokens, 1000);
  assert.equal(first.usage.contextWindowMaxTokens, 10000);

  await conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: { clientMessageId: 'm2', delivery: 'auto',
      input: { type: 'command', name: 'compact', arguments: '' } },
  });
  await waitFor(events, (e) => e.type === 'session.prompt_result' && e.clientMessageId === 'm2');

  const after = events.filter((e) => e.type === 'session.usage').at(-1);
  assert.equal(after.usage.contextWindowUsedTokens, 500, '/compact 之后占用要立刻掉一半');
  assert.equal(mock.calls.filter((c) => c.method === 'session/projections').length >= 2, true,
    '应通过单会话 projections 取值，而不是每次 listSessions');

  await conn.send({ type: 'session.close', requestId: 'r9', sessionId: 'p1' });
});

// ---------- 2026-11-10：Paseo 把 /compact 当普通文本发过来时的兜底 ----------
//
// 实测 0.15.3 的 bridge 不会把 "/compact" 转成 command 输入（仍走 session.prompt），
// provider 侧按 DSH 命令目录识别，命中就走 commands/execute；不在目录里的 "/xxx" 仍按文本。

test('lifecycle: 文本形式的 /compact 也能走 commands/execute（目录命中才拦）', async (t) => {
  const mock = await startMockDsh(() => {});
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
  await waitFor(events, (e) => e.type === 'session.commands');

  const sendText = (id, text) => conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: { clientMessageId: id, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text }] } },
  });

  await sendText('t1', '/compact');
  const done = await waitFor(events, (e) => e.type === 'session.prompt_result' && e.clientMessageId === 't1');
  assert.equal(done.result.type, 'completed');
  assert.equal(mock.calls.find((c) => c.method === 'commands/execute')?.args.line, '/compact');
  assert.ok(!mock.calls.some((c) => c.method === 'session/prompt'), '不应把命令当文本发给模型');

  // 不在 DSH 命令目录里的 "/..." 必须原样当文本发出去（别误伤路径或普通斜杠文本）
  await sendText('t2', '/usr/bin/env 是什么');
  await waitFor(events, (e) => e.type === 'session.prompt_result' && e.clientMessageId === 't2');
  assert.ok(mock.calls.some((c) => c.method === 'session/prompt'), '未知斜杠文本应走普通 prompt');

  await conn.send({ type: 'session.close', requestId: 'r9', sessionId: 'p1' });
});
