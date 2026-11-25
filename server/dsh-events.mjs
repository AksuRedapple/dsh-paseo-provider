/**
 * DSH `$events` 订阅：Host 侧 forwarded waterfall（`user-questions/request` 等）。
 *
 * 协议事实（2026-11-25：从 App 内 `@deepseek-ai/dsh-api-gateway` 逆出 + 实测）：
 *  · 同一条 `/api/remote.mux` 开逻辑流：
 *      → { type:'open', streamId, endpoint:'$events', payload:{ args:{} } }
 *      ← { type:'item', streamId, value:{ type:'ready', clientId, host:{ home } } }
 *      ← { type:'item', streamId, value:{ type:'waterfall', event, eventId, agentId, request } }
 *      ← { type:'item', streamId, value:{ type:'emit', event, args } }   // 单向广播
 *  · 只有 **owner peer**（用 DSH cookie 升级的连接）才收到 waterfall、才有答权；
 *    非 owner 只会收到受 ACL 过滤的 emit 广播，且回包会被 `gateway/invocation-unavailable` 拒。
 *  · 回包不走 WS，走 HTTP RPC `$events/result`（见 dsh-client.respondHostEvent）。
 *  · `clientId` 每次重连都会变；调用方必须按帧记录 clientId，不能自己缓存。
 *  · `agentId` 的 wire 类型就是 SessionId —— 直接用它找 Paseo session。
 */
import { getDshEndpoint } from './dsh-endpoint.mjs';

// 运行期读取：测试会给每个用例换 mock 端口
const muxUrl = () => process.env.DSH_MUX || 'ws://127.0.0.1:8781/api/remote.mux';
const DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10000];

function parseFrame(data) {
  try {
    return JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 订阅 Host forwarded events。
 * @param {object} [opts]
 * @param {(frame: {clientId: string, event: string, eventId: string, agentId: string, request: any}) => void} [opts.onFrame]
 *   每条 waterfall 帧（要客户端作答的那种）。clientId 是该帧所属流的。
 * @param {(info: {clientId: string}) => void} [opts.onReady] 流就绪（含每次重连）
 * @param {(msg: object) => void} [opts.onOther] 其它帧（emit 广播 / ready 之外的未知帧），排障用
 * @param {() => Promise<{url: string, connect: (url: string) => any} | null>} [opts.resolveEndpoint] 重连前重解析端点
 * @param {number[]} [opts.backoffMs]
 * @param {boolean} [opts.reconnect] 传 false 关闭自动重连（测试用）
 */
export function subscribeHostEvents(opts = {}) {
  const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : () => {};
  const onReady = typeof opts.onReady === 'function' ? opts.onReady : () => {};
  const onOther = typeof opts.onOther === 'function' ? opts.onOther : () => {};
  const resolveEndpoint = typeof opts.resolveEndpoint === 'function' ? opts.resolveEndpoint : null;
  const backoff = opts.backoffMs || DEFAULT_BACKOFF;
  const reconnectEnabled = opts.reconnect !== false;

  let url = opts.url || muxUrl();
  let connect = opts.connect || null;
  let ws = null;
  let closed = false;
  let retry = 0;
  let timer = null;
  let streamId = '';
  /** 当前流（含重连后）的 clientId —— 只有在收到 ready 之后才有意义。 */
  let clientId = null;

  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  ready.catch(() => {});

  const scheduleReconnect = () => {
    if (closed || !reconnectEnabled) return;
    const wait = backoff[Math.min(retry, backoff.length - 1)];
    retry += 1;
    timer = setTimeout(() => {
      timer = null;
      void open();
    }, wait);
    // 长连接子模块不该因为自己在等东西就把宿主进程钉着（测试里尤其致命：
    // 一条没人关的流会让 node --test 永远退不出去）。
    timer.unref?.();
  };

  const open = async () => {
    if (closed) return;
    if (resolveEndpoint) {
      // DSH 桌面端重启会换 launch token / 端口：永不为重连复用旧端点
      try {
        const ep = await resolveEndpoint();
        if (ep?.url && ep?.connect) {
          url = ep.url;
          connect = ep.connect;
        }
      } catch {}
    }
    if (closed) return;
    if (!connect) {
      // 无 cookie 时退化成裸 WebSocket（只有本地无鉴权场景；DSH 默认要 cookie）
      const { WebSocket: WsWebSocket } = await import('ws');
      connect = (u) => new WsWebSocket(u);
    }
    streamId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let socket;
    try {
      socket = connect(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws = socket;
    // 与 dsh-follow.mjs 同款：用 onXxx 属性，浏览器/`ws` 包都通，且不会重复注册
    socket.onopen = () => {
      retry = 0;
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }));
      // 同理：不让这条常驻连接把宿主进程钉住（daemon 自己有别的句柄）
      socket._socket?.unref?.();
    };
    socket.onmessage = onMessage;
    socket.onclose = onClose;
    socket.onerror = () => {};
  };

  const onMessage = (ev) => {
    const frame = parseFrame(ev?.data ?? ev);
    if (!frame) return;
    if (frame.type !== 'item' || frame.streamId !== streamId) return;
    const value = frame.value;
    if (!value || typeof value !== 'object') return;
    if (value.type === 'ready') {
      clientId = String(value.clientId || '') || null;
      resolveReady({ clientId });
      onReady({ clientId });
      return;
    }
    if (value.type === 'waterfall') {
      if (!clientId) return; // 没有 ready 就不该有 waterfall；丢掉也不会误答
      onFrame({
        clientId,
        event: String(value.event || ''),
        eventId: String(value.eventId || ''),
        agentId: String(value.agentId || ''),
        request: value.request ?? {},
      });
      return;
    }
    onOther(value);
  };

  const onClose = () => {
    if (closed) return;
    ws = null;
    clientId = null;
    scheduleReconnect();
  };

  void open();

  return {
    ready,
    /** 当前流的 clientId（ready 之前为 null）。 */
    clientId: () => clientId,
    close() {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try { ws?.close(); } catch {}
      ws = null;
      rejectReady(new Error('host event stream closed'));
    },
  };
}
