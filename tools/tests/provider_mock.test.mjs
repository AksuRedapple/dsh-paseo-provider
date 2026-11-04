import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { startMockDsh, sendMockTurn } from './mock-dsh.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && extname(specifier) === '' && !String(context.parentURL || '').includes('/node_modules/')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

test('provider-mock: WS prompt emits tool, text, usage, completion', async (t) => {
  const mock = await startMockDsh((ws, streamId) => sendMockTurn(ws, streamId), { hasMore: true });
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
  await conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: {
      clientMessageId: 'c1', delivery: 'auto',
      input: { type: 'message', content: [{ type: 'text', text: 'hello' }] },
    },
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for prompt_result')), 8000);
    const iv = setInterval(() => {
      if (events.some((e) => e.type === 'session.prompt_result' && e.result?.type === 'completed')) {
        clearTimeout(timer); clearInterval(iv); resolve();
      }
    }, 20);
  });

  // run 启动时必须先回 prompt_result(turn)，否则 Paseo 60s 后会判定 run 未启动
  const turnResult = events.find((e) => e.type === 'session.prompt_result' && e.result?.type === 'turn');
  assert.ok(turnResult, 'prompt_result(turn) expected when the turn starts');
  assert.match(turnResult.result.turnId, /^dsh-turn-/);
  const promptResult = events.find((e) => e.type === 'session.prompt_result' && e.result?.type === 'completed');
  assert.equal(promptResult.result.type, 'completed');

  const items = events.filter((e) => e.type === 'timeline.item').map((e) => e.item);
  const assistant = items.filter((i) => i.type === 'assistant_message').map((i) => i.text);
  assert.deepEqual(assistant, ['mock-answer'], 'text must appear exactly once');
  const tools = items.filter((i) => i.type === 'tool_call');
  assert.ok(tools.some((i) => i.status === 'running'), 'running tool card expected');
  const tool = tools.find((i) => i.status === 'completed');
  assert.ok(tool, 'completed tool card expected');
  assert.equal(tool.status, 'completed');

  const usage = events.find((e) => e.type === 'session.usage');
  assert.ok(usage, 'session.usage expected');
  assert.equal(usage.usage.inputTokens, 3);
  assert.equal(usage.usage.outputTokens, 2);

  const turn = events.find((e) => e.type === 'session.turn' && e.state === 'completed');
  assert.ok(turn, 'session.turn completed expected');
  assert.ok(!events.some((e) => e.type === 'session.notice' && /截断/.test(e.notice?.description || '')), 'no per-turn truncation notice');
});
