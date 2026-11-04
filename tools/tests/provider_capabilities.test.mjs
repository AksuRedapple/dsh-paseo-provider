import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { startMockDsh, sendMockTurn } from './mock-dsh.mjs';
import { classifyEvent, createTurnState } from '../../server/turn-state.mjs';

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

test('capabilities: 图片 prompt 转成 DSH mediaType；todo/write 进时间线', async (t) => {
  const mock = await startMockDsh((ws, streamId) => sendMockTurn(ws, streamId));
  process.env.DSH_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.DSH_MUX = `ws://127.0.0.1:${mock.port}`;
  t.after(() => mock.close());

  const { createProvider } = await import('../../server/provider.ts');
  const conn = await createProvider().connect({});
  const events = [];
  conn.onEvent((e) => events.push(e));

  await conn.send({ type: 'session.open', requestId: 'r1', sessionId: 'p1', config: { cwd: '/tmp' }, history: 'skip' });
  await conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: {
      clientMessageId: 'c1', delivery: 'auto',
      input: { type: 'message', content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ] },
    },
  });
  await waitFor(events, (e) => e.type === 'session.prompt_result' && e.result?.type === 'completed');

  const sent = mock.calls.find((c) => c.method === 'session/prompt')?.args;
  assert.deepEqual(sent.content, [
    { type: 'text', text: 'look at this' },
    { type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' },
  ]);

  const todo = events.filter((e) => e.type === 'timeline.item' && e.item.type === 'todo').at(-1)?.item;
  assert.ok(todo, 'todo timeline item expected');
  assert.deepEqual(todo.items.map((i) => [i.text, i.status]), [
    ['step one', 'completed'],
    ['step two', 'in_progress'],
  ]);
  const capabilities = events.find((e) => e.type === 'session.opened')?.capabilities || [];
  assert.ok(capabilities.includes('prompt.image'));
  assert.ok(capabilities.includes('prompt.steer'));
});

test('capabilities: steer 插入运行中的轮次并回同一个 turnId', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let prompts = 0;
  const mock = await startMockDsh(async (ws, streamId) => {
    prompts++;
    const send = (value) => ws.send(JSON.stringify({ type: 'item', streamId, value }));
    const now = Date.now();
    if (prompts === 1) {
      send({ type: 'event', event: { type: 'user/message', seq: 1, time: now,
        data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } });
      send({ type: 'event', event: { type: 'turn/start', seq: 2, time: now, data: { turn: 1 } } });
      send({ type: 'assistant-stream', frame: { type: 'start', turn: 1, step: 1 } });
      send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'partial' } } });
      await gate;
      send({ type: 'event', event: { type: 'assistant/message', seq: 4, time: now,
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'final' }] } } } });
      send({ type: 'event', event: { type: 'turn/end', seq: 5, time: now,
        data: { turn: 1, reason: { kind: 'completed' } } } });
    } else {
      // steer 命令落库后的用户消息
      send({ type: 'event', event: { type: 'user/message', seq: 3, time: now,
        data: { content: [{ type: 'text', text: 'also check the tests' }], source: { kind: 'user' } } } });
    }
  });
  process.env.DSH_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.DSH_MUX = `ws://127.0.0.1:${mock.port}`;
  t.after(() => mock.close());

  const { createProvider } = await import('../../server/provider.ts');
  const conn = await createProvider().connect({});
  const events = [];
  conn.onEvent((e) => events.push(e));

  await conn.send({ type: 'session.open', requestId: 'r1', sessionId: 'p1', config: { cwd: '/tmp' }, history: 'skip' });
  await conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: { clientMessageId: 'c1', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hello' }] } },
  });
  const started = await waitFor(events, (e) => e.type === 'session.turn' && e.state === 'started');
  assert.match(started.turnId, /^dsh-turn-/);

  await conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: { clientMessageId: 'c2', delivery: 'steer', input: { type: 'message', content: [{ type: 'text', text: 'also check the tests' }] } },
  });
  const steer = await waitFor(events, (e) => e.type === 'session.prompt_result' && e.clientMessageId === 'c2');
  assert.equal(steer.result.type, 'steer');
  assert.equal(steer.result.turnId, started.turnId);

  const calls = mock.calls.filter((c) => c.method === 'session/prompt');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.mode, 'steer');
  assert.deepEqual(calls[1].args.content, [{ type: 'text', text: 'also check the tests' }]);

  release();
  const final = await waitFor(events,
    (e) => e.type === 'session.prompt_result' && e.clientMessageId === 'c1' && e.result?.type === 'completed');
  assert.equal(final.result.type, 'completed');
});

test('capabilities: history replay 重建 user/assistant/tool/todo', async (t) => {
  const now = Date.now();
  const records = [
    { event: { type: 'user/message', seq: 1, time: now,
      data: { content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } } } },
    { event: { type: 'assistant/message', seq: 2, time: now,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'answer' }] } } } },
    { event: { type: 'tool/call', seq: 3, time: now,
      data: { callId: 'c1', name: 'bash', arguments: '{}' } } },
    { event: { type: 'tool/result', seq: 4, time: now,
      data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } } } },
    { event: { type: 'todo/write', seq: 5, time: now,
      data: { todos: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'in_progress' },
      ] } } },
    { event: { type: 'goal/change', seq: 6, time: now,
      data: { operation: 'create', roundsStarted: 2,
        goal: { id: 'g1', revision: 1, objective: 'Ship the thing', phase: 'active', maxGoalRounds: 10 } } } },
  ];
  const sessions = [{
    sessionId: 'mock-session',
    projections: {
      values: {
        goal: {
          goal: { id: 'g1', revision: 2, objective: 'Ship the thing', phase: 'completed', maxGoalRounds: 10 },
          roundsStarted: 3,
        },
      },
    },
  }];
  const mock = await startMockDsh(() => {}, { records, hasMore: true, sessions });
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
    history: 'replay',
  });
  await waitFor(events, (e) => e.type === 'session.ready');

  const items = events.filter((e) => e.type === 'timeline.item').map((e) => e.item);
  assert.ok(items.some((i) => i.type === 'user_message' && i.text === 'first question'));
  assert.ok(items.some((i) => i.type === 'assistant_message' && i.text === 'answer'));
  const tools = items.filter((i) => i.type === 'tool_call');
  assert.ok(tools.some((i) => i.status === 'running'), 'running tool card expected');
  const tool = tools.find((i) => i.status === 'completed');
  assert.equal(tool?.name, 'bash');
  assert.equal(tool?.status, 'completed');
  const todo = items.find((i) => i.type === 'todo' && i.id === 'dsh-todo');
  assert.equal(todo?.items?.length, 2);
  assert.equal(todo?.items?.[0]?.completed, true);
  // goal 只从 projections 出一张卡；历史里的 create/complete 不重复发
  const goals = items.filter((i) => i.type === 'todo' && i.id === 'dsh-goal');
  assert.equal(goals.length, 1, 'exactly one goal card expected');
  assert.match(goals[0].items?.[0]?.text || '', /Ship the thing/);
  assert.equal(goals[0].items?.[0]?.completed, true);

  // 快照截断是内部细节：只记日志，不应弹 notice
  assert.ok(!events.some((e) => e.type === 'session.notice' && /截断/.test(e.notice?.description || '')));
});


test('capabilities: session/end-seed 视为已知忽略事件', () => {
  assert.equal(classifyEvent('session/end-seed'), 'ignore');
  const st = createTurnState({ startSeq: 0, now: Date.now() });
  assert.deepEqual(st.onEvent({ type: 'session/end-seed', seq: 1, data: {} }), []);
});
