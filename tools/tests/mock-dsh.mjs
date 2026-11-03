import http from 'node:http';
import { WebSocketServer } from 'ws';

/** 启动一个 mock DSH：HTTP RPC + WS mux；prompt 后回调 onPrompt(ws, streamId)。 */
export async function startMockDsh(onPrompt, opts = {}) {
  let currentWs = null;
  let streamId = '';
  const sessions = opts.sessions || [];
  const records = opts.records || [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const method = String(req.url || '').replace(/^\/api\//, '');
      const value = method === 'session/create' ? { sessionId: 'mock-session' }
        : method === 'session/list' ? { items: sessions }
        : {};
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: { ok: true, value } }));
      if (method === 'session/prompt') {
        setTimeout(() => {
          if (currentWs) onPrompt(currentWs, streamId);
        }, 20);
      }
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    currentWs = ws;
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type !== 'open') return;
      streamId = m.streamId;
      ws.send(JSON.stringify({
        type: 'item', streamId,
        value: { type: 'snapshot', cursor: opts.cursor ?? 0, hasMore: false, records },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close() {
      try { wss.close(); } catch {}
      try { server.close(); } catch {}
    },
  };
}

/** 一轮带工具、文本与 usage 的标准 mock 事件。 */
export function sendMockTurn(ws, streamId) {
  const send = (value) => ws.send(JSON.stringify({ type: 'item', streamId, value }));
  const now = Date.now();
  send({ type: 'event', event: { type: 'user/message', seq: 1, time: now,
    data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } });
  send({ type: 'event', event: { type: 'tool/call', seq: 2, time: now,
    data: { callId: 'c1', name: 'bash', arguments: '{}' } } });
  send({ type: 'event', event: { type: 'tool/result', seq: 3, time: now,
    data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } } } });
  send({ type: 'assistant-stream', frame: { type: 'start', turn: 1, step: 1 } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'mock-answer' } } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: {
    type: 'usage', usage: { input_tokens: 3, output_tokens: 2 } } } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'finish' } } });
  send({ type: 'event', event: { type: 'assistant/message', seq: 4, time: now,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'mock-answer' }] } } } });
  send({ type: 'event', event: { type: 'turn/end', seq: 5, time: now,
    data: { turn: 1, reason: { kind: 'completed' } } } });
}
