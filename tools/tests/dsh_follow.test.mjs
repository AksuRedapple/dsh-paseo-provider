/**
 * dsh-follow 断线重连的端点重解析（2026-11-10）
 *
 * 线上事实：DSH 桌面端重启会换 launch token → 新 cookie，端口也可能变；
 * 旧实现重连只复用首连的 url，接不回去就把回合判死（11-07~08 四次）。
 * 这里用一个「端口会换」的两段式 mock 锁住行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { followSession } from '../../server/dsh-follow.mjs';

/** 起一个只回 snapshot 的 mux，收到 open 后回调 onOpen(ws, streamId)。 */
async function startMux(onOpen) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type !== 'open') return;
      ws.send(JSON.stringify({
        type: 'item', streamId: m.streamId,
        value: { type: 'snapshot', cursor: 0, hasMore: false, records: [] },
      }));
      onOpen(ws, m.streamId);
    });
  });
  return {
    port: wss.address().port,
    connections: () => wss.clients.size,
    close() {
      for (const c of wss.clients) { try { c.terminate(); } catch {} }
      try { wss.close(); } catch {}
    },
  };
}

const pushEvent = (ws, streamId, seq) => ws.send(JSON.stringify({
  type: 'item', streamId,
  value: { type: 'event', event: { type: 'assistant/message', seq, time: Date.now(), data: { message: { content: [{ type: 'text', text: `e${seq}` }] } } } },
}));

test('follow reconnect: 端点变了也能接上（重新解析 url）', async (t) => {
  const second = await startMux((ws, streamId) => {
    setTimeout(() => pushEvent(ws, streamId, 5), 20);
  });
  t.after(() => second.close());

  const first = await startMux((ws, streamId) => {
    // 第一次连接：发一条事件，然后像 DSH 重启那样「拔线」
    setTimeout(() => { pushEvent(ws, streamId, 3); }, 10);
    setTimeout(() => { try { ws.terminate(); } catch {} }, 40);
  });
  t.after(() => first.close());

  let resolutions = 0;
  const follow = followSession('session-test', {
    url: `ws://127.0.0.1:${first.port}`,
    backoffMs: [10, 20],
    readyTimeoutMs: 3000,
    resolveEndpoint: async () => {
      resolutions++;
      return { url: `ws://127.0.0.1:${second.port}` };
    },
  });
  t.after(() => follow.close());

  const seen = [];
  const deadline = Date.now() + 3000;
  for await (const msg of follow) {
    seen.push(msg);
    const gotNewPortEvent = seen.some((m) => m.kind === 'event' && m.event?.seq === 5);
    if (gotNewPortEvent) break;
    if (Date.now() > deadline) break;
  }

  assert.ok(seen.some((m) => m.kind === 'event' && m.event?.seq === 3), '第一段必须收到事件');
  assert.ok(seen.some((m) => m.kind === 'error' && m.reconnecting === true), '必须报一次可重连错误');
  assert.ok(resolutions >= 1, '重连前必须重新解析端点');
  assert.ok(seen.some((m) => m.kind === 'event' && m.event?.seq === 5), '必须从新端点继续收事件');
});

test('follow reconnect: resolveEndpoint 抛错时沿用旧端点继续重试', async (t) => {
  const alive = await startMux(() => {});
  t.after(() => alive.close());

  let attempts = 0;
  const follow = followSession('session-test-2', {
    url: `ws://127.0.0.1:${alive.port}`,
    backoffMs: [10, 20],
    readyTimeoutMs: 3000,
    resolveEndpoint: async () => { attempts++; throw new Error('exchange failed'); },
  });
  t.after(() => follow.close());

  // 首次连接成功后主动断开一次，确认解析失败也没有把流弄死
  await follow.ready;
  alive.close();

  const deadline = Date.now() + 2000;
  let errors = 0;
  for await (const msg of follow) {
    if (msg.kind === 'error' && msg.reconnecting) errors++;
    if (errors >= 2 || Date.now() > deadline) break;
  }
  assert.ok(attempts >= 1, '必须尝试过重新解析');
  assert.ok(errors >= 1, '解析失败也要继续走重连');
});
