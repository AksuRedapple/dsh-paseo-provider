import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockDsh } from './mock-dsh.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('acp-load: replays records and replies after updates', async (t) => {
  const now = Date.now();
  const mock = await startMockDsh(() => {}, {
    records: [
      { event: { type: 'user/message', seq: 1, time: now,
        data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } } },
      { event: { type: 'assistant/message', seq: 2, time: now,
        data: { message: { content: [{ type: 'text', text: 'hello' }] } } } },
    ],
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
  let buf = '';
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'mock-session' } });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for session/load')), 8000);
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.method === 'session/update') updates.push(j.params.update);
        if (j.id === 2) { clearTimeout(timer); resolve(j.result); }
      }
    });
  });

  assert.deepEqual(result, {});
  const types = updates.map((u) => u.sessionUpdate);
  assert.ok(types.includes('user_message_chunk'));
  assert.ok(types.includes('agent_message_chunk'));
});
