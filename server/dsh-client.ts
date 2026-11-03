/**
 * DSH RPC 客户端（2026-11-02 探针验证通过）
 *
 * 三个必须知道的契约（实测）：
 *  1. 信封：{ type:"client-request", rpcId, method, payload:{ args:{ _request:{} } } }
 *  2. **响应是 brotli 压缩，但没有 Content-Encoding 头** —— 必须无条件试 brotli
 *  3. 去掉压缩后是普通 JSON：{ type:"server-response", result:{ ok, value } }
 */
import zlib from 'node:zlib';

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:8781';

export async function rpc<T = any>(
  method: string,
  args: Record<string, unknown> = {},
  wrap: '_request' | 'request' = '_request',
  timeoutMs = 30_000,
): Promise<T> {
  const body = {
    type: 'client-request',
    rpcId: `p${Date.now()}`,
    method,
    payload: { args: { [wrap]: args } },
  };
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'br' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let text: string;
  try {
    text = zlib.brotliDecompressSync(buf).toString('utf8');
  } catch {
    text = buf.toString('utf8');
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    // DSH 后端不可达时 8781 会返回纯文本（如「DSH 上游不可达：connect ECONNREFUSED」）
    throw new Error(`DSH rpc ${method} failed: HTTP ${res.status} ${text.trim().slice(0, 200)}`);
  }
  if (!json?.result?.ok) {
    throw new Error(`DSH rpc ${method} failed: ${JSON.stringify(json?.result?.error)}`);
  }
  return json.result.value as T;
}

export interface DshSession {
  sessionId: string;
  updatedAt: number;
  agentAvailable: boolean;
  running: boolean;
  blank: boolean;
  cwd: string | null;
  projections?: { values?: { title?: string; goal?: string | null } };
}

/** 轻量探活：DSH 8781 根路径；>=500 或网络错误视为不可用。 */
export async function probeDsh(timeoutMs = 1500): Promise<{ ok: boolean; diagnostic?: string }> {
  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 500) return { ok: false, diagnostic: `DSH upstream HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, diagnostic: `DSH unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function listSessions(): Promise<DshSession[]> {
  const v = await rpc<{ items: DshSession[] }>('session/list');
  return v.items || [];
}


/** 发一条用户消息（2026-11-02 从 DSH Web 实际请求抄下的形状）。 */
export async function promptSession(sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<any> {
  return rpc('session/prompt', {
    requestId: crypto.randomUUID(),
    sessionId,
    mode,
    content: [{ type: 'text', text }],
    clientTimeZone: 'Asia/Shanghai',
  } as any, 'request');
}


/** 在 DSH 侧新建一个会话，返回其 sessionId。 */
export async function createSession(cwd: string): Promise<string> {
  const v = await rpc<{ sessionId: string }>('session/create', { cwd } as any, 'request');
  return v.sessionId;
}

/** 中断当前 turn（DSH 的接口名是 session/cancel，不是 interrupt）。 */
export async function interruptSession(sessionId: string): Promise<void> {
  await rpc('session/cancel', { sessionId } as any, 'request', 10_000);
}
