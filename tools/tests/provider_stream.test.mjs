/**
 * 回归测试：DSH provider 的「回复慢一拍」缺陷（2026-11-03 用户实测）
 *
 * 现象：Paseo 里发消息回复不出现；发下一条时才看到上一条的回复，且自己发的话重复一遍。
 * 根因：streamNewEvents 每次从 lastSeq = -1 起 → 重放整段历史；历史里的
 *       assistant/message 让 sawAssistant 立刻为真，空闲一轮就收工，本轮回复还没落库
 *       就发了 prompt_result，Paseo 关掉本轮。
 *
 * 本文件锁三条不变量：
 *   1. 流起点必须 > baseline —— 历史事件不得被当新事件 emit
 *   2. 不能回声用户自己那条消息 —— 从 waitForUserEcho 返回的 seq 之后开始流
 *   3. 顺序：assistant 文本必须先于 prompt_result
 * 另有护栏/边界测试：startSeq 必填、标题补全并发上限、echo 超时兜底、错误消息可读。
 *
 * 约束：不连 DSH、不连网络、不启 paseo。事件全靠假数组 + 注入的 fetch。
 *
 * 跑法：node --test provider_stream.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { readFileSync } from 'node:fs';

// provider.ts 里 import 的是 './dsh-client'（无扩展名，给 Paseo 打包器用的）。
// 原生 ESM 要求扩展名，这里用 Node 内置的同步解析钩子补 .ts，不引入任何依赖。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && extname(specifier) === '' && !String(context.parentURL || '').includes('/node_modules/')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { maxSeqOf, waitForUserEcho, streamNewEvents, fillMissingTitles, errorMessage, runTurn } =
  await import('../../server/provider.ts');
const { followSession } = await import('../../server/dsh-ws.ts');
const { createTurnState } = await import('../../server/turn-state.mjs');

// ---------- 假事件 ----------

const T0 = 1_700_000_000_000;
const time = (seq) => T0 + seq * 1000;

const userMsg = (seq, text) => ({
  type: 'user/message',
  seq,
  time: time(seq),
  data: { id: `u${seq}`, content: [{ type: 'text', text }] },
});

const assistantMsg = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: time(seq),
  data: { message: { content: [{ type: 'text', text }] } },
});

// 只有 tool-call、没有正文的 assistant 消息（真机上误触发早收工的那种）
const assistantToolCall = (seq) => ({
  type: 'assistant/message',
  seq,
  time: time(seq),
  data: { message: { content: [{ type: 'tool-call', id: `c${seq}`, name: 'bash', arguments: '{}' }] } },
});

const turnEnd = (seq) => ({
  type: 'turn/end',
  seq,
  time: time(seq),
  data: { turn: 1, reason: { kind: 'completed' } },
});

/** 每次调用都返回同一份「完整历史快照」，模拟 DSH session/follow 的行为。 */
function staticFetch(events) {
  const calls = [];
  const fn = async (dshId, timeoutMs) => {
    calls.push({ dshId, timeoutMs });
    return events;
  };
  fn.calls = calls;
  return fn;
}

function collector() {
  const emitted = [];
  return { emitted, emit: (e) => emitted.push(e) };
}

const items = (emitted) =>
  emitted.filter((e) => e.type === 'timeline.item').map((e) => e.item);

// 历史：两轮旧对话，其中包含旧的 assistant/message（正是原来误判收工的元凶）
const HISTORY = [
  userMsg(1, 'old question one'),
  assistantMsg(2, 'old answer one'),
  userMsg(3, 'old question two'),
  assistantMsg(4, 'old answer two'),
];

// ---------- 不变量 1 ----------

test('invariant-1: stream starts after baseline, never replays history', async () => {
  const dshId = 'dsh-1';
  const historyFull = [
    ...HISTORY,
    userMsg(5, 'new question'),
    assistantMsg(6, 'new answer'),
  ];

  // 提问前取水位：应等于历史最大 seq
  const baseline = await maxSeqOf(dshId, staticFetch(HISTORY));
  assert.equal(baseline, 4, 'baseline should be the max seq of history');

  const { emitted, emit } = collector();
  // budget 很小：只跑一轮，验证「第一轮就不会 emit 历史」
  await streamNewEvents('paseo-1', dshId, emit, 50, baseline, staticFetch(historyFull));

  const got = items(emitted);
  assert.deepEqual(
    got.map((i) => [i.type, i.text]),
    [
      ['user_message', 'new question'],
      ['assistant_message', 'new answer'],
    ],
    'only events after baseline may be emitted',
  );
  assert.ok(!got.some((i) => i.text.startsWith('old ')), 'history must not be replayed');
});

// ---------- 不变量 2 ----------

test('invariant-2: user echo is not re-emitted as timeline item', async () => {
  const dshId = 'dsh-2';
  const question = 'echo me please';
  const afterPrompt = [...HISTORY, userMsg(5, question)];
  const withAnswer = [...afterPrompt, assistantMsg(6, 'the answer')];

  const baseline = await maxSeqOf(dshId, staticFetch(HISTORY));
  assert.equal(baseline, 4);

  // 等自己这条 user/message 落库：应返回它的 seq，而不是 baseline
  const echoSeq = await waitForUserEcho(
    dshId, question, baseline, 2_000, staticFetch(withAnswer),
  );
  assert.equal(echoSeq, 5, 'waitForUserEcho must return the seq of our own user/message');

  const { emitted, emit } = collector();
  await streamNewEvents('paseo-2', dshId, emit, 50, echoSeq, staticFetch(withAnswer));

  const got = items(emitted);
  assert.equal(got.length, 1, 'exactly one new item expected');
  assert.equal(got[0].type, 'assistant_message');
  assert.equal(got[0].text, 'the answer');
  assert.ok(
    !got.some((i) => i.type === 'user_message' || i.text === question),
    'our own user/message must never be echoed back',
  );
});

// ---------- 不变量 3 ----------

test('invariant-3: assistant text precedes prompt_result', async () => {
  const dshId = 'dsh-3';
  const question = 'answer me now';
  const historyFull = [...HISTORY, userMsg(5, question)];

  // 模拟真实时序：assistant 比 echo 晚落库（前两次轮询还没有）
  let calls = 0;
  const delayedFetch = async () => {
    const n = calls++;
    return n < 2
      ? historyFull
      : [...historyFull, assistantMsg(6, 'the real answer')];
  };

  const { emitted, emit } = collector();

  // 下面这段顺序照抄 provider.ts 的 session.prompt 分支：
  //   baseSeq = maxSeqOf → promptSession（测试里省略，无网络）→ waitForUserEcho → streamNewEvents → prompt_result
  const baseSeq = await maxSeqOf(dshId, staticFetch(HISTORY));
  const echoSeq = await waitForUserEcho(dshId, question, baseSeq, 2_000, staticFetch(historyFull));
  await streamNewEvents('paseo-3', dshId, emit, 2_000, echoSeq, delayedFetch, 20);
  emit({
    type: 'session.prompt_result',
    sessionId: 'paseo-3',
    clientMessageId: 'c1',
    result: { type: 'completed' },
  });

  assert.equal(baseSeq, 4);
  assert.equal(echoSeq, 5);

  const assistantIdx = emitted.findIndex(
    (e) => e.type === 'timeline.item' &&
      e.item.type === 'assistant_message' &&
      e.item.text === 'the real answer',
  );
  const resultIdx = emitted.findIndex(
    (e) => e.type === 'session.prompt_result' && e.result?.type === 'completed',
  );

  assert.ok(assistantIdx >= 0, 'the new assistant message must be emitted');
  assert.ok(resultIdx >= 0, 'prompt_result(completed) must be emitted');
  assert.ok(
    assistantIdx < resultIdx,
    `assistant (index ${assistantIdx}) must precede prompt_result (index ${resultIdx})`,
  );
  // 旧历史里的 assistant 不能冒充本轮回复让流提前收工
  const assistantItems = items(emitted).filter((i) => i.type === 'assistant_message');
  assert.deepEqual(assistantItems.map((i) => i.text), ['the real answer']);

  // 行为测试 + 源码顺序双保险：provider.ts 里 prompt_result 必须在 runTurn 之后
  const src = readFileSync(new URL('../../server/provider.ts', import.meta.url), 'utf8');
  const streamAt = src.indexOf('void runTurn(input.sessionId');
  const resultAt = streamAt < 0 ? -1 : src.indexOf("type: 'session.prompt_result'", streamAt);
  assert.ok(streamAt >= 0, 'session.prompt branch must start runTurn');
  assert.ok(resultAt > streamAt, 'prompt_result must be emitted only after runTurn starts');
});

// ---------- 护栏：startSeq 必填 ----------

test('guard-1: streamNewEvents rejects when startSeq is omitted', async () => {
  await assert.rejects(
    () => streamNewEvents('paseo-4', 'dsh-4', () => {}, 50),
    /startSeq 必须显式传入/,
    'omitting startSeq must throw instead of defaulting to -1 (history replay)',
  );
});

// ---------- 边界：tool-call 不能触发早收工 ----------

test('turn-1: tool-call assistant does not end the stream before reply text', async () => {
  const dshId = 'dsh-6';
  const question = 'run the tool';
  const withTool = [
    ...HISTORY,
    userMsg(5, question),
    assistantToolCall(6),
    { type: 'tool/call', seq: 7, time: time(7), data: { callId: 'c6', name: 'bash' } },
    { type: 'tool/result', seq: 8, time: time(8), data: { toolCallId: 'c6', message: { content: [{ type: 'text', text: 'ok' }] } } },
  ];
  const withText = [...withTool, assistantMsg(9, 'final answer')];
  // 关键时序：回复正文在 2 轮空闲之后才落库（真机 2026-11-03 抓到的形态）
  const snapshots = [withTool, withTool, withTool, withText, [...withText, turnEnd(10)]];
  let call = 0;
  const fakeFetch = async () => snapshots[Math.min(call++, snapshots.length - 1)];

  const { emitted, emit } = collector();
  await streamNewEvents('paseo-6', dshId, emit, 2_000, 5, fakeFetch, 10);

  const texts = items(emitted)
    .filter((i) => i.type === 'assistant_message')
    .map((i) => i.text);
  assert.deepEqual(texts, ['final answer'], 'reply text must be emitted even after tool-call idle gaps');
});

// ---------- 边界：标题补全并发上限 ----------

test('limit-1: fillMissingTitles caps concurrent snapshot fetches', async () => {
  let inFlight = 0;
  let peak = 0;
  const fakeFetch = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return [userMsg(1, 'first question')];
  };
  const items = Array.from({ length: 12 }, (_, i) => ({
    sessionId: `s-${i}`,
    projections: { values: {} },
  }));

  await fillMissingTitles(items, 50, fakeFetch, 4);

  assert.equal(peak, 4, 'at most 4 snapshot fetches may be in flight');
  assert.ok(
    items.every((s) => s.projections.values.title === 'first question'),
    'every target should still get a title',
  );
});

// ---------- 边界：echo 超时兜底 ----------

test('echo-1: waitForUserEcho falls back to the latest seq on timeout', async () => {
  // 快照里只有旧历史（max seq=4），不会出现本次提问的 user/message
  const seq = await waitForUserEcho('dsh-5', 'never lands', 4, 80, staticFetch(HISTORY));
  assert.equal(seq, 4, 'timeout must fall back to the max seq seen, never replay');
});

// ---------- 边界：错误消息可读 ----------

test('error-1: errorMessage is human readable', () => {
  assert.equal(errorMessage(new Error('dsh rpc session/list failed: boom')), 'dsh rpc session/list failed: boom');
  assert.equal(errorMessage('plain failure'), 'plain failure');
  assert.equal(errorMessage(''), 'unknown error');
});

// ---------- 持久 follow：重复帧 / 重置 / 截断 ----------

function fakeSocket() {
  return {
    onopen: null, onmessage: null, onclose: null, onerror: null,
    sent: [], closed: false,
    send(d) { this.sent.push(d); },
    close() { this.closed = true; },
  };
}

const frame = (streamId, value) => ({ data: JSON.stringify({ type: 'item', streamId, value }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('follow-1: snapshot baseline + incremental events dedupe', async () => {
  const sock = fakeSocket();
  const follow = followSession('dsh-1', { connect: () => sock, reconnect: false, readyTimeoutMs: 100 });
  sock.onopen();
  const streamId = JSON.parse(sock.sent[0]).streamId;

  sock.onmessage(frame(streamId, { type: 'snapshot', cursor: 4, hasMore: false, records: [] }));
  const snap = await follow.ready;
  assert.equal(snap.cursor, 4);

  sock.onmessage(frame(streamId, { type: 'event', event: userMsg(5, 'new q') }));
  sock.onmessage(frame(streamId, { type: 'event', event: userMsg(5, 'duplicate') }));
  sock.onmessage(frame(streamId, { type: 'event', event: assistantMsg(6, 'new a') }));

  const it = follow[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.kind, 'snapshot');
  assert.equal((await it.next()).value.event.seq, 5);
  assert.equal((await it.next()).value.event.seq, 6);
  follow.close();
});

test('follow-2: reconnect snapshot below cursor is a reset, history is not replayed', async () => {
  const s1 = fakeSocket();
  const s2 = fakeSocket();
  let n = 0;
  const follow = followSession('dsh-2', {
    connect: () => (n++ === 0 ? s1 : s2),
    backoffMs: [1], readyTimeoutMs: 100,
  });
  s1.onopen();
  const id1 = JSON.parse(s1.sent[0]).streamId;
  s1.onmessage(frame(id1, { type: 'snapshot', cursor: 10, hasMore: false, records: [] }));
  await follow.ready;

  s1.onclose({ code: 1006 });
  await sleep(20);
  s2.onopen();
  const id2 = JSON.parse(s2.sent[0]).streamId;
  s2.onmessage(frame(id2, {
    type: 'snapshot', cursor: 3, hasMore: false,
    records: [{ event: userMsg(1, 'old') }, { event: userMsg(2, 'old2') }],
  }));

  const it = follow[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.kind, 'snapshot');
  const err = await it.next();
  assert.equal(err.value.kind, 'error');
  const reset = await it.next();
  assert.equal(reset.value.kind, 'reset');
  assert.deepEqual([reset.value.from, reset.value.to], [10, 3]);
  const snap2 = await it.next();
  assert.equal(snap2.value.kind, 'snapshot');
  assert.equal(snap2.value.cursor, 3);
  follow.close();
});

// ---------- 共享 turn 状态机 ----------

test('state-1: echo is suppressed, tool-call is not a reply, turn/end completes', () => {
  const st = createTurnState({ promptText: 'hello', startSeq: 4, now: 0 });
  let acts = st.onEvent(userMsg(5, 'hello'));
  assert.ok(acts.some((a) => a.type === 'echo'));
  assert.ok(!acts.some((a) => a.type === 'timeline'), 'echo must not become timeline');

  acts = st.onEvent(assistantToolCall(6));
  assert.ok(acts.some((a) => a.type === 'timeline'));
  assert.equal(st.sawReplyText, false, 'tool-call must not count as reply');

  acts = st.onEvent(turnEnd(7));
  const done = acts.find((a) => a.type === 'done');
  assert.equal(done.reason, 'completed');
  assert.equal(st.phase, 'done');
});

test('state-2: truncated and reset notices come from snapshots', () => {
  const st = createTurnState({ promptText: '', startSeq: 10, now: 0, startPhase: 'running' });
  let acts = st.onSnapshot({ cursor: 10, hasMore: true });
  assert.ok(acts.some((a) => a.type === 'truncated'));
  acts = st.onSnapshot({ cursor: 3, hasMore: false });
  const reset = acts.find((a) => a.type === 'reset');
  assert.deepEqual([reset.from, reset.to], [10, 3]);
});

test('state-3: injected context user messages are not emitted; real user messages are', () => {
  const st = createTurnState({ promptText: 'hello', startSeq: 0, now: 0 });
  st.onEvent(userMsg(1, 'hello')); // echo
  let acts = st.onEvent({
    type: 'user/message', seq: 2, time: time(2),
    data: { content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }] },
  });
  assert.ok(!acts.some((a) => a.type === 'timeline'), 'injected context must be ignored');

  acts = st.onEvent({
    type: 'user/message', seq: 3, time: time(3),
    data: { content: [{ type: 'text', text: 'a real user message' }], source: { kind: 'user' } },
  });
  assert.ok(acts.some((a) => a.type === 'timeline'), 'real user message must be emitted');
});

// ---------- runTurn：持久流 + 状态机 + tool 结算 ----------

test('run-1: runTurn emits reply, suppresses echo, settles pending tool', async () => {
  const messages = [
    { kind: 'event', event: userMsg(5, 'hello') },
    { kind: 'event', event: { type: 'tool/call', seq: 6, time: time(6), data: { callId: 'c1', name: 'bash', arguments: '{}' } } },
    { kind: 'event', event: assistantMsg(9, 'final answer') },
    { kind: 'event', event: turnEnd(10) },
  ];
  let i = 0;
  const fakeFollow = {
    ready: Promise.resolve({ cursor: 4, hasMore: false, events: [] }),
    close() {},
    [Symbol.asyncIterator]() {
      return { next: async () => (i < messages.length ? { value: messages[i++], done: false } : { value: undefined, done: true }) };
    },
  };
  const emits = [];
  const { reason } = await runTurn('paseo-9', 'dsh-9', 'hello', (e) => emits.push(e), {
    follow: () => fakeFollow,
    prompt: async () => {},
    tickMs: 5,
  });

  assert.equal(reason, 'completed');
  const items = emits.filter((e) => e.type === 'timeline.item').map((e) => e.item);
  assert.deepEqual(
    items.filter((x) => x.type === 'assistant_message').map((x) => x.text),
    ['final answer'],
  );
  assert.ok(!items.some((x) => x.type === 'user_message'), 'echo must be suppressed');
  assert.ok(items.some((x) => x.type === 'tool_call' && x.status === 'failed'), 'pending tool must settle');
  assert.ok(emits.some((e) => e.type === 'session.turn' && e.state === 'completed'));
});

test('run-2: abort cancels a running turn and closes the follow', async () => {
  let closed = false;
  let wake;
  const fakeFollow = {
    ready: Promise.resolve({ cursor: 1, hasMore: false, events: [] }),
    close() { closed = true; wake?.({ value: undefined, done: true }); },
    [Symbol.asyncIterator]() {
      return {
        next: () => (closed
          ? Promise.resolve({ value: undefined, done: true })
          : new Promise((resolve) => { wake = resolve; })),
      };
    },
  };
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  const { reason } = await runTurn('paseo-10', 'dsh-10', 'hello', () => {}, {
    follow: () => fakeFollow,
    prompt: async () => {},
    tickMs: 5,
    signal: ctl.signal,
  });
  assert.equal(reason, 'canceled');
  assert.equal(closed, true);
});

test('run-3: pending tool is settled by the 60s timeout sweep', async () => {
  const t0 = 1_000_000;
  const started = Date.now();
  // 把虚拟时间加速 2000x：真实 40ms ≈ 80s
  const fakeNow = () => t0 + (Date.now() - started) * 2000;
  let closed = false;
  let wake;
  let sent = false;
  const toolEv = { type: 'tool/call', seq: 1, time: t0, data: { callId: 'c1', name: 'bash', arguments: '{}' } };
  const fakeFollow = {
    ready: Promise.resolve({ cursor: 0, hasMore: false, events: [] }),
    close() { closed = true; wake?.({ value: undefined, done: true }); },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (closed) return Promise.resolve({ value: undefined, done: true });
          if (!sent) { sent = true; return Promise.resolve({ value: { kind: 'event', event: toolEv }, done: false }); }
          return new Promise((resolve) => { wake = resolve; });
        },
      };
    },
  };
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 120);
  const emits = [];
  await runTurn('paseo-11', 'dsh-11', 'hello', (e) => emits.push(e), {
    follow: () => fakeFollow,
    prompt: async () => {},
    now: fakeNow,
    tickMs: 5,
    toolTimeoutMs: 60_000,
    signal: ctl.signal,
  });
  const failed = emits
    .filter((e) => e.type === 'timeline.item' && e.item.type === 'tool_call')
    .map((e) => e.item)
    .find((i) => i.status === 'failed');
  assert.ok(failed, 'pending tool must be settled');
  assert.match(String(failed.error?.message), /timeout/);
});

test('run-4: assistant-stream preview is emitted and the final duplicate is skipped', async () => {
  const messages = [
    { kind: 'assistant', frame: { type: 'start', turn: 1, step: 1 } },
    // 真实 chunk 帧不带 turn/step，必须沿用 start 的 key
    { kind: 'assistant', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'think ' } } },
    { kind: 'assistant', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'answer ' } } },
    { kind: 'assistant', frame: { type: 'chunk', chunk: { type: 'finish' } } },
    {
      kind: 'event',
      event: {
        type: 'assistant/message', seq: 2, time: time(2),
        data: { turn: 1, step: 1, message: { content: [
          { type: 'reasoning', text: 'think ' },
          { type: 'text', text: 'answer ' },
        ] } },
      },
    },
    { kind: 'event', event: turnEnd(3) },
  ];
  let i = 0;
  const fakeFollow = {
    ready: Promise.resolve({ cursor: 0, hasMore: false, events: [] }),
    close() {},
    [Symbol.asyncIterator]() {
      return { next: async () => (i < messages.length ? { value: messages[i++], done: false } : { value: undefined, done: true }) };
    },
  };
  const emits = [];
  await runTurn('paseo-12', 'dsh-12', 'hello', (e) => emits.push(e), {
    follow: () => fakeFollow,
    prompt: async () => {},
    tickMs: 5,
  });
  const items = emits.filter((e) => e.type === 'timeline.item').map((e) => e.item);
  assert.deepEqual(items.filter((x) => x.type === 'reasoning').map((x) => x.text), ['think ']);
  assert.deepEqual(items.filter((x) => x.type === 'assistant_message').map((x) => x.text), ['answer ']);
});

test('run-5: usage chunk maps to session.usage', async () => {
  const messages = [
    { kind: 'assistant', frame: { type: 'chunk', chunk: {
      type: 'usage', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    } } },
    { kind: 'event', event: turnEnd(2) },
  ];
  let i = 0;
  const fakeFollow = {
    ready: Promise.resolve({ cursor: 0, hasMore: false, events: [] }),
    close() {},
    [Symbol.asyncIterator]() {
      return { next: async () => (i < messages.length ? { value: messages[i++], done: false } : { value: undefined, done: true }) };
    },
  };
  const emits = [];
  await runTurn('paseo-13', 'dsh-13', 'hello', (e) => emits.push(e), {
    follow: () => fakeFollow,
    prompt: async () => {},
    tickMs: 5,
  });
  const usage = emits.find((e) => e.type === 'session.usage');
  assert.ok(usage, 'session.usage must be emitted');
  assert.deepEqual(usage.usage, { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 });
});
