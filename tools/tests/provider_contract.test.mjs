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

const waitFor = async (events, pred, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for event');
};

test('contract: sessions title fill, history replay, unsupported input', async (t) => {
  const now = Date.now();
  const records = [{
    event: {
      type: 'user/message', seq: 1, time: now,
      data: { content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } },
    },
  }];
  const mock = await startMockDsh(() => {}, {
    records,
    sessions: [
      { sessionId: 's-titled', updatedAt: now, cwd: '/tmp', projections: { values: { title: 'Titled' } } },
      { sessionId: 'mock-session', updatedAt: now, cwd: '/tmp', projections: { values: {} } },
    ],
  });
  process.env.DSH_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.DSH_MUX = `ws://127.0.0.1:${mock.port}`;
  t.after(() => mock.close());

  const { createProvider } = await import('../../server/provider.ts');
  const conn = await createProvider().connect({});
  const events = [];
  conn.onEvent((e) => events.push(e));

  await conn.send({ type: 'sessions', requestId: 'r1', limit: 10 });
  const sessions = await waitFor(events, (e) => e.type === 'sessions');
  assert.equal(sessions.sessions.length, 2);
  assert.equal(sessions.sessions[0].title, 'Titled');
  assert.equal(sessions.sessions[1].title, 'first question', 'missing title must be filled');
  assert.equal(sessions.sessions[1].persistence.data.sessionId, 'mock-session');

  await conn.send({
    type: 'session.open', requestId: 'r2', sessionId: 'p1',
    config: { cwd: '/tmp' },
    persistence: { version: 1, data: { sessionId: 'mock-session' } },
    history: 'replay',
  });
  await waitFor(events, (e) => e.type === 'session.ready');
  const items = events.filter((e) => e.type === 'timeline.item').map((e) => e.item);
  assert.ok(items.some((i) => i.type === 'user_message' && i.text === 'first question'));

  await conn.send({ type: 'session.configure', requestId: 'r3', sessionId: 'p1' });
  const failed = await waitFor(events, (e) => e.type === 'request.failed' && e.requestId === 'r3');
  assert.equal(failed.error.code, 'dsh/unsupported');
});
