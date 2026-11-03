import http from 'node:http';
import { WebSocketServer } from 'ws';

/** 与真机同形的目录：provider 分组 + reasoning efforts + 默认模型。 */
export const MOCK_CATALOG = {
  default: { provider: 'prov-a', model: 'mock-pro' },
  routableProviders: ['prov-a'],
  groups: [
    {
      id: 'prov-a',
      name: 'Mock',
      models: [
        {
          id: 'mock-pro',
          name: 'Mock Pro',
          description: 'pro model',
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        },
        { id: 'mock-flash', name: 'Mock Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } },
      ],
    },
  ],
};

/** 启动一个 mock DSH：HTTP RPC + WS mux；prompt 后回调 onPrompt(ws, streamId)。 */
export async function startMockDsh(onPrompt, opts = {}) {
  let currentWs = null;
  let streamId = '';
  const sessions = opts.sessions || [];
  const records = opts.records || [];
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const method = String(req.url || '').replace(/^\/api\//, '');
      let args = {};
      try {
        const j = JSON.parse(body);
        args = j?.payload?.args?.request ?? j?.payload?.args?._request ?? j?.payload?.args ?? {};
      } catch {}
      calls.push({ method, args });
      const value = method === 'session/create' ? { sessionId: opts.sessionId || 'mock-session' }
        : method === 'session/list' ? { items: sessions }
        : method === 'session/modelCatalog' ? (opts.catalog || MOCK_CATALOG)
        : method === 'session/selectModel' ? {
          selected: {
            provider: args.provider,
            model: args.model,
            ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
          },
        }
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
    calls,
    close() {
      try { wss.close(); } catch {}
      try { server.close(); } catch {}
    },
  };
}

/** 一轮带工具、todo、文本与 usage 的标准 mock 事件。 */
export function sendMockTurn(ws, streamId) {
  const send = (value) => ws.send(JSON.stringify({ type: 'item', streamId, value }));
  const now = Date.now();
  send({ type: 'event', event: { type: 'user/message', seq: 1, time: now,
    data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } });
  send({ type: 'event', event: { type: 'tool/call', seq: 2, time: now,
    data: { callId: 'c1', name: 'bash', arguments: '{}' } } });
  send({ type: 'event', event: { type: 'tool/result', seq: 3, time: now,
    data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } } } });
  send({ type: 'event', event: { type: 'todo/write', seq: 4, time: now,
    data: { todos: [
      { content: 'step one', status: 'completed' },
      { content: 'step two', status: 'in_progress' },
    ] } } });
  send({ type: 'assistant-stream', frame: { type: 'start', turn: 1, step: 1 } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'mock-answer' } } });
  // 旧版 snake_case 与真机 camelCase 各发一次，两条映射路径都被覆盖
  send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: {
    type: 'usage', usage: { input_tokens: 3, output_tokens: 2 } } } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: {
    type: 'usage', usage: { inputTokens: 3, cacheReadTokens: 5, outputTokens: 2, totalTokens: 10 } } } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'finish' } } });
  send({ type: 'event', event: { type: 'assistant/message', seq: 5, time: now,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'mock-answer' }] } } } });
  send({ type: 'event', event: { type: 'turn/end', seq: 6, time: now,
    data: { turn: 1, reason: { kind: 'completed' } } } });
}
