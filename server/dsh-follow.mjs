/**
 * DSH mux 持久 follow（WS provider 与 ACP server 共用）。
 *
 * 一次 open 消费 snapshot → event / assistant-stream：
 *   · 断线指数退避重连；重连快照补发 seq > lastSeq 的记录；
 *   · snapshot.cursor < lastSeq 判 seq 重置，重建基线且不回放；
 *   · hasMore 发 truncated；未知帧发 unknown；重连缺口发 gap。
 */
const MUX = process.env.DSH_MUX || 'ws://127.0.0.1:8781/api/remote.mux';
const DEFAULT_BACKOFF = [250, 500, 1000, 2000, 5000];

function parseFrame(data) {
  try {
    return JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  } catch {
    return null;
  }
}

export function followSession(sessionId, opts = {}) {
  const url = opts.url || MUX;
  const connect = opts.connect || ((u) => new WebSocket(u));
  const backoff = opts.backoffMs || DEFAULT_BACKOFF;
  const reconnectEnabled = opts.reconnect !== false;

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
      open();
    }, delay);
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

export async function readSnapshot(sessionId, timeoutMs = 15000) {
  const follow = followSession(sessionId, { reconnect: false, readyTimeoutMs: timeoutMs });
  try {
    return await follow.ready;
  } catch {
    return { cursor: -1, hasMore: false, events: [] };
  } finally {
    follow.close();
  }
}
