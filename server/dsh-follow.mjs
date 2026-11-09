/**
 * DSH mux 持久 follow（WS provider 共用）。
 *
 * 一次 open 消费 snapshot → event / assistant-stream：
 *   · 断线指数退避重连；重连快照补发 seq > lastSeq 的记录；
 *   · 重连前可用 resolveEndpoint() 重新解析端点（DSH 重启会换 token/端口）；
 *   · snapshot.cursor < lastSeq 判 seq 重置，重建基线且不回放；
 *   · hasMore 发 truncated；未知帧发 unknown；重连缺口发 gap。
 */
import { getDshEndpoint } from './dsh-endpoint.mjs';

// 运行期读取：测试会给每个用例换 mock 端口
const muxUrl = () => process.env.DSH_MUX || 'ws://127.0.0.1:8781/api/remote.mux';
const DEFAULT_BACKOFF = [250, 500, 1000, 2000, 5000];

function parseFrame(data) {
  try {
    return JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  } catch {
    return null;
  }
}

export function followSession(sessionId, opts = {}) {
  let url = opts.url || muxUrl();
  let connect = opts.connect
    || ((u) => {
      if (opts.headers) throw new Error('followSession: headers require a connect function (ws)');
      return new WebSocket(u);
    });
  const backoff = opts.backoffMs || DEFAULT_BACKOFF;
  const reconnectEnabled = opts.reconnect !== false;
  /**
   * 重连前重解析端点（2026-11-10）：DSH 桌面端重启会换 launch token / cookie，
   * 端口也可能变；只复用首连的 url 会永远接不回去（2026-11-07~08 的回合失败即此）。
   * 返回 {url, connect}；抛错或返回空就沿用旧值。
   */
  const resolveEndpoint = typeof opts.resolveEndpoint === 'function' ? opts.resolveEndpoint : null;
  let reconnects = 0;

  const queue = [];
  let waiting = null;
  let closed = false;
  let ws = null;
  let lastSeq = -1;
  let firstSnapshot = true;
  let truncatedSent = false;
  let retry = 0;
  let reconnectTimer = null;
  let readyTimer = null;
  let readySettled = false;

  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  const push = (m) => {
    if (closed) return;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w({ value: m, done: false });
    } else {
      queue.push(m);
    }
  };

  const finish = () => {
    closed = true;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    if (waiting) {
      const w = waiting;
      waiting = null;
      w({ value: undefined, done: true });
    }
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error('followSession closed before first snapshot'));
    }
  };

  const iterator = {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((res) => { waiting = res; });
    },
  };

  const handleSnapshot = (value) => {
    const events = (Array.isArray(value?.records) ? value.records : [])
      .map((r) => r?.event).filter(Boolean);
    const seqs = events.map((e) => Number(e.seq)).filter((n) => Number.isFinite(n));
    const cursor = Number.isFinite(Number(value?.cursor))
      ? Number(value.cursor)
      : (seqs.length ? Math.max(...seqs) : lastSeq);
    const hasMore = value?.hasMore === true;

    let skipReplay = false;
    const prevSeq = lastSeq;
    if (cursor < lastSeq) {
      push({ kind: 'reset', from: lastSeq, to: cursor });
      lastSeq = cursor;
      skipReplay = true; // 重置后不回放，避免重复
    }

    if (!firstSnapshot && !skipReplay) {
      let recovered = 0;
      for (const ev of events) {
        if (Number.isFinite(ev.seq) && ev.seq > lastSeq) {
          lastSeq = ev.seq;
          recovered++;
          push({ kind: 'event', event: ev });
        }
      }
      if (cursor > prevSeq && recovered < cursor - prevSeq) {
        push({ kind: 'gap', from: prevSeq, to: cursor });
      }
    }

    lastSeq = Math.max(lastSeq, cursor);

    if (!readySettled) {
      readySettled = true;
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      resolveReady({ cursor: lastSeq, hasMore, events });
    }

    push({ kind: 'snapshot', cursor: lastSeq, hasMore, events });

    if (hasMore && !truncatedSent) {
      truncatedSent = true;
      push({ kind: 'truncated', cursor: lastSeq });
    }
    firstSnapshot = false;
  };

  const open = () => {
    if (closed) return;
    if (reconnects > 0 && resolveEndpoint) {
      // 重连走一次重新解析：DSH 重启后 launch token / cookie 会换，端口也可能变。
      // 解析失败不阻断重试，继续沿用旧端点。
      Promise.resolve()
        .then(() => resolveEndpoint())
        .then((next) => {
          if (next && typeof next.url === 'string' && next.url) url = next.url;
          if (next && typeof next.connect === 'function') connect = next.connect;
        })
        .catch(() => {})
        .then(() => { if (!closed) dial(); });
      return;
    }
    dial();
  };

  const dial = () => {
    if (closed) return;
    let sock;
    try {
      sock = connect(url);
    } catch (e) {
      scheduleReconnect(e);
      return;
    }
    ws = sock;
    const streamId = crypto.randomUUID();

    sock.onopen = () => {
      retry = 0;
      sock.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: {
          args: {
            request: {
              address: { kind: 'session', sessionId },
              assistantStream: opts.assistantStream !== false,
              maxMessages: opts.maxMessages ?? 500,
              turnWindow: { minMessages: 50, minTurns: 2 },
            },
          },
        },
      }));
    };

    sock.onmessage = (e) => {
      const j = parseFrame(e.data);
      if (!j || j.type !== 'item' || j.streamId !== streamId) return;
      const value = j.value || {};
      if (value.type === 'snapshot') return handleSnapshot(value);
      if (value.type === 'event' && value.event) {
        const ev = value.event;
        if (Number.isFinite(ev.seq) && ev.seq <= lastSeq) return;
        if (Number.isFinite(ev.seq)) lastSeq = ev.seq;
        push({ kind: 'event', event: ev });
        return;
      }
      if (value.type === 'assistant-stream') {
        push({ kind: 'assistant', frame: value.frame });
        return;
      }
      push({ kind: 'unknown', valueType: String(value.type || j.type || '?') });
    };

    sock.onerror = () => scheduleReconnect(new Error('websocket error'));

    sock.onclose = (e) => {
      if (closed) return;
      scheduleReconnect(new Error(`websocket closed (${e?.code ?? '?'})`));
    };
  };

  const scheduleReconnect = (error) => {
    if (closed || reconnectTimer) return;
    try { ws?.close(); } catch {}
    ws = null;
    if (!reconnectEnabled) {
      push({ kind: 'error', error, reconnecting: false });
      finish();
      return;
    }
    push({ kind: 'error', error, reconnecting: true });
    const delay = backoff[Math.min(retry++, backoff.length - 1)];
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnects++;
      open();
    }, delay);
    // 只读观察者可能长期重试；不要因为一个退避定时器把进程钉住
    reconnectTimer.unref?.();
  };

  open();

  if (opts.readyTimeoutMs) {
    readyTimer = setTimeout(() => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error('followSession: first snapshot timeout'));
      }
    }, opts.readyTimeoutMs);
    readyTimer.unref?.();
  }

  return {
    ready,
    [Symbol.asyncIterator]() { return iterator; },
    close() {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch {}
      finish();
    },
  };
}

export async function readSnapshot(sessionId, timeoutMs = 15000, opts = {}) {
  let url = opts.url;
  let headers = opts.headers;
  if (!url) {
    try {
      const ep = await getDshEndpoint();
      url = ep.mux;
      if (ep.cookie) headers = { cookie: ep.cookie };
    } catch {}
  }
  let connect = opts.connect;
  if (!connect && headers?.cookie) {
    const { WebSocket: WsWebSocket } = await import('ws');
    connect = (u) => new WsWebSocket(u, { headers });
  }
  const follow = followSession(sessionId, { reconnect: false, readyTimeoutMs: timeoutMs, url, headers, connect });
  try {
    return await follow.ready;
  } catch {
    return { cursor: -1, hasMore: false, events: [] };
  } finally {
    follow.close();
  }
}
