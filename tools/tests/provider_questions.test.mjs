/**
 * 提问卡（DSH `ask_user_question` → Paseo `session.permission`）端到端回归。
 *
 * 覆盖三条线：
 *  1. 开了会话就订阅 `$events`（且只开一条）；
 *  2. waterfall 帧 → `session.permission`（kind=question，题干/选项/多选都到位）；
 *  3. 回包 → `$events/result`（clientId/eventId/outcome 精确），并补 `session.permission_resolved`；
 *  4. 桌面端先答（我们只看到 tool/result）→ 卡片同样收尾，不留悬卡。
 *
 * 单独一个文件跑：`$events` 是长连接，和别的用例共享进程时可能抢到旧 mock 的连接。
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

/** 等 mock 收到某条 HTTP RPC（provider 的回包是异步的）。 */
const waitForCall = async (mock, method, ms = 10000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = mock.calls.find((c) => c.method === method);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${method}`);
};

const QUESTIONS = [
  {
    id: 'scope',
    question: '改哪一层？',
    header: 'Choose Mode',
    options: [
      { label: '只改 provider（Recommended）', description: '最小改动' },
      { label: '连 gateway 一起改' },
    ],
  },
  { id: 'tags', question: '要哪些？', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true },
];

/** 开一个 mock DSH + 一个 provider 连接 + 一个已打开的会话。 */
async function openProvider(t, opts = {}) {
  const mock = await startMockDsh(() => {}, { sessions: [{ sessionId: 'mock-session' }] });
  process.env.DSH_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.DSH_MUX = `ws://127.0.0.1:${mock.port}`;
  t.after(() => mock.close());

  const { createProvider } = await import('../../server/provider.ts');
  const conn = await createProvider().connect({});
  const events = [];
  conn.onEvent((e) => events.push(e));
  t.after(() => conn.close().catch(() => {}));

  await conn.send({
    type: 'session.open', requestId: 'r1', sessionId: 'p1',
    config: { cwd: '/tmp' },
    persistence: { version: 1, data: { sessionId: 'mock-session' } },
    history: 'skip',
  });
  await waitFor(events, (e) => e.type === 'session.ready');
  return { mock, conn, events };
}

/** 等 `$events` 流就绪（provider 是 session.open 之后才连的）。 */
const waitEventStream = async (mock, ms = 10000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (mock.eventStreamCount() > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('$events stream not opened');
};

test('提问卡：waterfall → session.permission → 回包 $events/result', async (t) => {
  const { mock, conn, events } = await openProvider(t);
  await waitEventStream(mock);
  assert.equal(mock.eventStreamCount(), 1, '开了会话就应该只开一条 $events 流');

  assert.equal(mock.sendEvent({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId: 'ev-1',
    agentId: 'mock-session',
    request: { questions: QUESTIONS, wait: { callId: 'call-1' } },
  }), true);

  const perm = await waitFor(events, (e) => e.type === 'session.permission');
  assert.equal(perm.sessionId, 'p1');
  assert.equal(perm.request.id, 'call-1');
  assert.equal(perm.request.kind, 'question');
  assert.equal(perm.request.name, 'ask_user_question');
  assert.deepEqual(perm.request.metadata, { dshEventId: 'ev-1' });
  const qs = perm.request.input.questions;
  assert.equal(qs.length, 2);
  assert.equal(qs[0].header, 'Choose Mode');
  assert.equal(qs[0].question, '改哪一层？');
  assert.deepEqual(qs[0].options.map((o) => o.label), ['只改 provider（Recommended）', '连 gateway 一起改']);
  assert.equal(qs[1].multiSelect, true);

  // 人答完了 → provider 应该回 $events/result
  await conn.send({
    type: 'session.permission',
    sessionId: 'p1',
    permissionId: 'call-1',
    response: {
      behavior: 'allow',
      updatedInput: { answers: { 'Choose Mode': '连 gateway 一起改', Q2: 'a, b' } },
    },
  });

  const resolved = await waitFor(events, (e) => e.type === 'session.permission_resolved');
  assert.equal(resolved.permissionId, 'call-1');
  assert.equal(resolved.sessionId, 'p1');

  const resultCall = await waitForCall(mock, '$events/result');
  assert.equal(resultCall.args.clientId, mock.eventClientId());
  assert.equal(resultCall.args.eventId, 'ev-1');
  assert.deepEqual(resultCall.args.outcome, {
    kind: 'result',
    value: {
      answers: [
        { id: 'scope', selected: ['连 gateway 一起改'] },
        { id: 'tags', selected: ['a', 'b'] },
      ],
    },
  });
});

test('提问卡：弹掉 → rejected ASK_CANCELLED，卡片不悬着', async (t) => {
  const { mock, conn, events } = await openProvider(t);
  await waitEventStream(mock);

  mock.sendEvent({
    type: 'waterfall', event: 'user-questions/request', eventId: 'ev-2', agentId: 'mock-session',
    request: { questions: QUESTIONS, wait: { callId: 'call-2' } },
  });
  await waitFor(events, (e) => e.type === 'session.permission' && e.request.id === 'call-2');

  await conn.send({ type: 'session.permission', sessionId: 'p1', permissionId: 'call-2', response: { behavior: 'deny' } });

  await waitFor(events, (e) => e.type === 'session.permission_resolved' && e.permissionId === 'call-2');
  const call = await waitForCall(mock, '$events/result');
  assert.deepEqual(call.args.outcome, {
    kind: 'rejected',
    error: { name: 'UserQuestionError', message: 'the user dismissed ask_user_question', code: 'ASK_CANCELLED' },
  });
});

test('提问卡：没 time 到 callId 的 legacy 提问，靠 tool/result 收尾（桌面端先答）', async (t) => {
  const { mock, events } = await openProvider(t);
  await waitEventStream(mock);

  // legacy 阻塞式提问：request 里没有 wait.callId → 卡片 id 退化成 eventId
  mock.sendEvent({
    type: 'waterfall', event: 'user-questions/request', eventId: 'ev-3', agentId: 'mock-session',
    request: { questions: QUESTIONS },
  });
  const perm = await waitFor(events, (e) => e.type === 'session.permission');
  assert.equal(perm.request.id, 'ev-3');

  // 桌面端抢先答了 → 我们只看到工具返回；卡片必须跟着收尾
  mock.send({ type: 'event', event: { type: 'tool/call', seq: 20, time: Date.now(),
    data: { callId: 'call-3', name: 'ask_user_question', arguments: JSON.stringify({ questions: QUESTIONS }) } } });
  mock.send({ type: 'event', event: { type: 'tool/result', seq: 21, time: Date.now(),
    data: { toolCallId: 'call-3', message: { content: [{ type: 'text', text: '{"answers":[]}' }] } } } });

  const resolved = await waitFor(events, (e) => e.type === 'session.permission_resolved');
  assert.equal(resolved.permissionId, 'ev-3');
});

test('提问卡：不认识的会话/其它 forwarded 事件一律不认领', async (t) => {
  const { mock, events } = await openProvider(t);
  await waitEventStream(mock);

  // 别的 DSH 会话（Paseo 没开）提问 → 不认领（没卡，也不回包）
  mock.sendEvent({
    type: 'waterfall', event: 'user-questions/request', eventId: 'ev-4', agentId: 'session-not-open',
    request: { questions: QUESTIONS, wait: { callId: 'call-4' } },
  });
  // 其它 forwarded 事件同样忽略
  mock.sendEvent({ type: 'emit', event: 'api-session/status', args: {} });
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(events.filter((e) => e.type === 'session.permission').length, 0);
  assert.equal(mock.calls.filter((c) => c.method === '$events/result').length, 0);
});
