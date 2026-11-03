import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockDsh, sendMockTurn } from './mock-dsh.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('acp-config: configOptions 暴露模型与思考档位；set_config_option 生效；usage_update 带上上下文窗口', async (t) => {
  const mock = await startMockDsh((ws, streamId) => sendMockTurn(ws, streamId), {
    sessions: [{
      sessionId: 'mock-session',
      projections: {
        values: {
          contextPressure: { contextWindow: 1_000_000 },
          modelSelection: { next: { provider: 'prov-a', model: 'mock-pro' } },
        },
      },
    }],
  });
  const child = spawn(process.execPath, ['acp-server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_BASE: `http://127.0.0.1:${mock.port}`,
      DSH_MUX: `ws://127.0.0.1:${mock.port}`,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => {
    try { child.kill(); } catch {}
    mock.close();
  });

  const updates = [];
  const responses = new Map();
  let buf = '';
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp' } });

  const onResponse = (id, fn) => {
    responses.set(id, fn);
  };
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for prompt result')), 10_000);
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.method === 'session/update') updates.push(j.params.update);
        if (j.id !== undefined && responses.has(j.id)) {
          const fn = responses.get(j.id);
          responses.delete(j.id);
          fn(j.result);
        }
        if (j.id === 4) { clearTimeout(timer); resolve(); }
      }
    });
  });

  onResponse(2, (result) => {
    assert.equal(result.sessionId, 'mock-session');
    // modelCatalog 的参数必须是裸 {}（真机 Gateway 会把包错的 key 当非法字段拒绝）
    assert.deepEqual(mock.calls.find((c) => c.method === 'session/modelCatalog')?.args, {});
    const model = result.configOptions?.find((o) => o.category === 'model');
    const effort = result.configOptions?.find((o) => o.category === 'thought_level');
    assert.ok(model, 'model config option expected');
    assert.equal(model.currentValue, 'prov-a::mock-pro');
    assert.deepEqual(model.options.map((o) => o.value), ['prov-a::mock-pro', 'prov-a::mock-flash']);
    assert.ok(effort, 'thought_level config option expected');
    assert.equal(effort.currentValue, 'high');
    send({
      jsonrpc: '2.0', id: 3, method: 'session/set_config_option',
      params: { sessionId: 'mock-session', configId: 'model', value: 'prov-a::mock-flash' },
    });
  });

  onResponse(3, (result) => {
    const model = result.configOptions?.find((o) => o.category === 'model');
    const effort = result.configOptions?.find((o) => o.category === 'thought_level');
    assert.equal(model.currentValue, 'prov-a::mock-flash');
    assert.equal(effort.currentValue, 'off', 'flash 的默认 effort 是 off');
    const selects = mock.calls.filter((c) => c.method === 'session/selectModel');
    assert.equal(selects.length, 1);
    assert.deepEqual(selects[0].args, { sessionId: 'mock-session', provider: 'prov-a', model: 'mock-flash' });
    send({ jsonrpc: '2.0', id: 4, method: 'session/prompt',
      params: { sessionId: 'mock-session', prompt: [{ type: 'text', text: 'hello' }] } });
  });

  await done;
  const usage = updates.filter((u) => u.sessionUpdate === 'usage_update');
  assert.ok(usage.length >= 1, 'usage_update expected');
  assert.ok(usage.some((u) => u.used === 8), 'camelCase inputTokens + cacheReadTokens');
  assert.ok(usage.every((u) => u.size === 1_000_000), 'size 来自 contextPressure.contextWindow');
});
