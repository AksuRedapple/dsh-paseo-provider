import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { startMockDsh } from './mock-dsh.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && extname(specifier) === '') {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const SESSION_ITEM = {
  sessionId: 'mock-session',
  projections: { values: { modelSelection: { next: { provider: 'prov-a', model: 'mock-flash' } } } },
};

test('provider-models: catalog 按 provider 分组，session.open 同步当前模型，configure 切模型', async (t) => {
  const mock = await startMockDsh(() => {}, { sessions: [SESSION_ITEM] });
  process.env.DSH_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.DSH_MUX = `ws://127.0.0.1:${mock.port}`;
  t.after(() => mock.close());

  const { createProvider } = await import('../../server/provider.ts');
  const conn = await createProvider().connect({});
  const events = [];
  conn.onEvent((e) => events.push(e));

  await conn.send({ type: 'catalog', requestId: 'r1' });
  const cat = events.find((e) => e.type === 'catalog')?.catalog;
  assert.ok(cat, 'catalog event expected');
  assert.deepEqual(cat.models.map((m) => m.id), ['prov-a::mock-pro', 'prov-a::mock-flash']);
  assert.equal(cat.defaultModel, 'prov-a::mock-pro');
  assert.deepEqual(cat.models[0].thinkingOptions.map((o) => o.id), ['low', 'high']);
  assert.equal(cat.models[0].defaultThinkingOptionId, 'high');
  // modelCatalog 的参数必须是裸 {}（真机 Gateway 会把包错的 key 当非法字段拒绝）
  assert.deepEqual(mock.calls.find((c) => c.method === 'session/modelCatalog')?.args, {});

  // 已有会话：模型从 session/list 的 projections.modelSelection 来，而不是目录默认值
  await conn.send({ type: 'session.open', requestId: 'r2', sessionId: 'p1', config: { cwd: '/tmp' }, history: 'skip' });
  const openedCapabilities = events.find((e) => e.type === 'session.opened')?.capabilities || [];
  assert.ok(openedCapabilities.includes('session.configure'));
  const cfg0 = events.find((e) => e.type === 'session.config')?.config;
  assert.equal(cfg0?.model, 'prov-a::mock-flash');
  assert.equal(cfg0?.thinkingOption, 'off');

  // configure → DSH session/selectModel（模型 + reasoning effort 一次带上）
  await conn.send({
    type: 'session.configure', requestId: 'r3', sessionId: 'p1',
    changes: { model: 'prov-a::mock-pro', thinkingOption: 'low' },
  });
  const selects = mock.calls.filter((c) => c.method === 'session/selectModel');
  assert.equal(selects.length, 1);
  assert.deepEqual(selects[0].args, {
    sessionId: 'mock-session', provider: 'prov-a', model: 'mock-pro', reasoningEffort: 'low',
  });
  const cfg1 = events.filter((e) => e.type === 'session.config').at(-1)?.config;
  assert.equal(cfg1?.model, 'prov-a::mock-pro');
  assert.equal(cfg1?.thinkingOption, 'low');
  assert.ok(events.find((e) => e.type === 'request.completed' && e.requestId === 'r3'));

  // 旧版持久化 id（dsh-default）：不调 selectModel，保留当前模型并给出 notice
  const before = mock.calls.filter((c) => c.method === 'session/selectModel').length;
  await conn.send({
    type: 'session.configure', requestId: 'r4', sessionId: 'p1', changes: { model: 'dsh-default' },
  });
  assert.equal(mock.calls.filter((c) => c.method === 'session/selectModel').length, before);
  assert.ok(events.find((e) => e.type === 'session.notice' && /未知模型/.test(e.notice?.description || '')));
  assert.ok(events.find((e) => e.type === 'request.completed' && e.requestId === 'r4'));
});

test('provider-models: usage 同时认真机 camelCase 与旧版 snake_case', async () => {
  const { usageFromChunk } = await import('../../server/provider.ts');
  assert.deepEqual(
    usageFromChunk({ usage: { inputTokens: 26227, cacheReadTokens: 384, outputTokens: 6, totalTokens: 26617 } }),
    { inputTokens: 26227, cachedInputTokens: 384, outputTokens: 6 },
  );
  assert.deepEqual(
    usageFromChunk({ usage: { input_tokens: 3, output_tokens: 2 } }),
    { inputTokens: 3, cachedInputTokens: undefined, outputTokens: 2 },
  );
  assert.equal(usageFromChunk({ usage: {} }), null);
  assert.equal(usageFromChunk(null), null);
});
