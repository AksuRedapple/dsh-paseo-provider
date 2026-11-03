// probe.mjs — DSH RPC 探针（不依赖 Paseo，验证「调用 + 解帧」全链）
// 2026-11-02：DSH 的 /api/* 响应是 brotli 压缩但**不发 Content-Encoding 头**，
// 客户端必须无条件尝试 brotli 解压，否则拿到的是密文。
import zlib from 'node:zlib';

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:8781';

async function rpc(method, args = {}) {
  const body = { type: 'client-request', rpcId: 'p1', method, payload: { args: { _request: args } } };
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'br' },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  // 无头压缩：先试 brotli，失败再当明文
  let text;
  try { text = zlib.brotliDecompressSync(buf).toString('utf8'); }
  catch { text = buf.toString('utf8'); }
  const json = JSON.parse(text);
  if (!json.result?.ok) throw new Error(`RPC ${method} failed: ${JSON.stringify(json.result?.error)}`);
  return json.result.value;
}

const value = await rpc('session/list');
const items = value.items || [];
console.log(`会话 ${items.length} 个`);
for (const s of items.slice(0, 6)) {
  const v = s.projections?.values || {};
  const t = new Date(s.updatedAt).toISOString().slice(5, 16).replace('T', ' ');
  const flags = [s.running && '运行中', s.agentAvailable && '在线', s.blank && '空'].filter(Boolean).join('/') || '-';
  console.log(`  ${t}  ${flags}  ${(v.title || '(无标题)').slice(0, 38)}  ${s.cwd || ''}`);
}
