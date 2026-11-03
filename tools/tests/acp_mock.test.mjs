import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockDsh, sendMockTurn } from './mock-dsh.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('acp-mock: prompt path streams text + tool lifecycle', async (t) => {
  const mock = await startMockDsh((ws, streamId) => sendMockTurn(ws, streamId));
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
  send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp' } });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for prompt result')), 8000);
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.method === 'session/update') updates.push(j.params.update);
        if (j.id === 2) {
          send({ jsonrpc: '2.0', id: 3, method: 'session/prompt',
            params: { sessionId: 'mock-session', prompt: [
              { type: 'text', text: 'hello' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ] } });
        }
        if (j.id === 3) { clearTimeout(timer); resolve(j.result); }
      }
    });
  });

  assert.equal(result.stopReason, 'end_turn');
  const types = updates.map((u) => u.sessionUpdate);
  assert.ok(types.includes('tool_call'), 'tool_call update expected');
  assert.ok(types.includes('tool_call_update'), 'tool_call_update expected');
  const plan = updates.filter((u) => u.sessionUpdate === 'plan').at(-1);
  assert.ok(plan, 'plan update expected');
  assert.deepEqual(plan.entries.map((e) => [e.content, e.status]), [
    ['step one', 'completed'],
    ['step two', 'in_progress'],
  ]);
  const promptCall = mock.calls.find((c) => c.method === 'session/prompt');
  assert.deepEqual(promptCall.args.content, [
    { type: 'text', text: 'hello' },
    { type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' },
  ]);
  const text = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => u.content?.text).join('');
  assert.equal(text, 'mock-answer', 'text must be streamed exactly once');
});
