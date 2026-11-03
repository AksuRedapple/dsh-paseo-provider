// 直连 DSH 的 /api/remote.mux，看首帧与消息形状
const url = process.env.WS || 'ws://127.0.0.1:8781/api/remote.mux';
const ws = new WebSocket(url);
let n = 0;
const t = setTimeout(() => { console.log('[timeout] 共收到', n, '帧'); process.exit(0); }, 8000);
ws.onopen = () => console.log('[open]', url);
ws.onmessage = (e) => {
  n++;
  const d = typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8');
  if (n <= 3) console.log(`[frame ${n}] len=${d.length}`, d.slice(0, 400));
};
ws.onerror = (e) => console.log('[error]', e.message || e.type);
ws.onclose = (e) => { clearTimeout(t); console.log('[close]', e.code, e.reason); process.exit(0); };
