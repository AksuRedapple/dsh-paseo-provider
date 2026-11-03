/**
 * DSH RPC 客户端（2026-11-02 探针验证通过）
 *
 * 三个必须知道的契约（实测）：
 *  1. 信封：{ type:"client-request", rpcId, method, payload:{ args:{ _request:{} } } }
 *  2. **响应是 brotli 压缩，但没有 Content-Encoding 头** —— 必须无条件试 brotli
 *  3. 去掉压缩后是普通 JSON：{ type:"server-response", result:{ ok, value } }
 */
import zlib from 'node:zlib';

// 运行期读取：测试会给每个用例换 mock 端口
const base = () => process.env.DSH_BASE || 'http://127.0.0.1:8781';

export async function rpc<T = any>(
  method: string,
  args: Record<string, unknown> = {},
  // 实测：不同端点的参数包装不一样 —— session/list 用 _request，session/create /
  // session/prompt / session/selectModel 用 request，session/modelCatalog 裸参数（无包装）。
  wrap: '_request' | 'request' | 'none' = '_request',
  timeoutMs = 30_000,
): Promise<T> {
  const body = {
    type: 'client-request',
    rpcId: `p${Date.now()}`,
    method,
    payload: { args: wrap === 'none' ? args : { [wrap]: args } },
  };
  const res = await fetch(`${base()}/api/${method}`, {
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
  projections?: {
    values?: {
      title?: string;
      goal?: string | null;
      modelSelection?: { lastUsed?: DshModelRef | null; next?: DshModelRef | null };
      contextPressure?: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number };
      tokenUsage?: { uncachedInputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
    };
  };
}

export interface DshModelRef {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

export interface DshCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: { efforts?: DshReasoningEffort[]; defaultEffort?: string };
}

export interface DshModelCatalog {
  default?: DshModelRef;
  routableProviders?: string[];
  groups?: Array<{ id: string; name: string; models?: DshCatalogModel[] }>;
}

/** 轻量探活：DSH 8781 根路径；>=500 或网络错误视为不可用。 */
export async function probeDsh(timeoutMs = 1500): Promise<{ ok: boolean; diagnostic?: string }> {
  try {
    const res = await fetch(`${base()}/`, { signal: AbortSignal.timeout(timeoutMs) });
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


export type DshPromptBlock = {
  type: 'text';
  text: string;
} | {
  type: 'image';
  data: string;
  mediaType: string;
};

/** 发一条用户消息。content 可以是纯文本，也可以是 text/image 块数组。
 *  实测：图片块的字段是 mediaType（不是 mimeType），2026-11-03 gateway 校验通过。 */
export async function promptSession(
  sessionId: string,
  content: string | DshPromptBlock[],
  mode: 'queue' | 'steer' = 'queue',
): Promise<any> {
  const blocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
  return rpc('session/prompt', {
    requestId: crypto.randomUUID(),
    sessionId,
    mode,
    content: blocks,
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

/** DSH 模型目录：按 provider 分组，default 指向当前默认模型。 */
export async function modelCatalog(): Promise<DshModelCatalog> {
  return rpc<DshModelCatalog>('session/modelCatalog', {}, 'none', 10_000);
}

/** 切换会话模型；reasoningEffort 可选（实测会被原样接受并回显在 selected 里）。 */
export async function selectModel(
  sessionId: string,
  provider: string,
  model: string,
  reasoningEffort?: string,
): Promise<{ selected: DshModelRef }> {
  const args: Record<string, unknown> = { sessionId, provider, model };
  if (reasoningEffort) args.reasoningEffort = reasoningEffort;
  return rpc('session/selectModel', args, 'request', 10_000);
}
