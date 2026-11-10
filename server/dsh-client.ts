/**
 * DSH RPC 客户端（2026-11-02 探针验证通过）
 *
 * 三个必须知道的契约（实测）：
 *  1. 信封：{ type:"client-request", rpcId, method, payload:{ args:{ _request:{} } } }
 *  2. **响应是 brotli 压缩，但没有 Content-Encoding 头** —— 必须无条件试 brotli
 *  3. 去掉压缩后是普通 JSON：{ type:"server-response", result:{ ok, value } }
 */
import zlib from 'node:zlib';
import { getDshEndpoint, clearDshEndpointCache } from './dsh-endpoint.mjs';

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
  let res: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ep = await getDshEndpoint({ force: attempt > 0 });
    res = await fetch(`${ep.base}/api/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept-encoding': 'br',
        ...(ep.cookie ? { cookie: ep.cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // token 随 DSH 重启变化：认证失败时强制刷新一次端点缓存
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      clearDshEndpointCache();
      continue;
    }
    break;
  }
  if (!res) throw new Error(`DSH rpc ${method} failed: no response`);
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

/** 降级指引：这个 provider 只服务"桌面版正在运行"的场景，别让只有 CLI 的用户在这上面耗时间。 */
export const DESKTOP_ONLY_HINT =
  'This plugin needs the DSH desktop app running on this machine; '
  + 'a CLI-only dsh setup should use a CLI/ACP based provider instead.';

/** 轻量探活：DSH 根路径；>=500 或网络错误视为不可用，401/403 给出认证诊断。 */
export async function probeDsh(timeoutMs = 1500): Promise<{ ok: boolean; diagnostic?: string }> {
  try {
    const ep = await getDshEndpoint();
    if (ep.source === 'legacy-fallback') {
      // 没读到 launch token：桌面版没起，或启动方式绕过了日志（open -a / 双击）
      return {
        ok: false,
        diagnostic: `no DSH launch token found in the platform log paths; set DSH_WEB_LOG, or start the desktop app through launchd. ${DESKTOP_ONLY_HINT}`,
      };
    }
    const res = await fetch(`${ep.base}/`, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(ep.cookie ? { headers: { cookie: ep.cookie } } : {}),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        diagnostic: `DSH reachable but authentication failed (${ep.source}); the launch token is stale — restart the desktop app, then reload this plugin (or set DSH_COOKIE)`,
      };
    }
    if (res.status >= 500) return { ok: false, diagnostic: `DSH upstream HTTP ${res.status}. ${DESKTOP_ONLY_HINT}` };
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      diagnostic: `DSH desktop app unreachable (${e instanceof Error ? e.message : String(e)}). ${DESKTOP_ONLY_HINT}`,
    };
  }
}

/** 单会话 projections（比 session/list 便宜：只取一个会话的状态）。
 *  实测：`{request:{sessionId}}`；返回 `{kind:'sequenced', asOfSeq, values:{...}}`。 */
export async function sessionProjections(sessionId: string): Promise<Record<string, any> | null> {
  const v = await rpc<{ values?: Record<string, any> }>('session/projections', { request: { sessionId } }, 'none');
  return v?.values || null;
}

export interface DshCommand {
  definitionId: string;
  name: string;
  description?: string;
  input?: { hint?: string; attachments?: boolean };
}

/** DSH 的斜杠命令目录（agentId = DSH session id）。 */
export async function listCommands(agentId: string): Promise<DshCommand[]> {
  return rpc<DshCommand[]>('commands/list', { agentId }, 'none');
}

/** 执行一条 DSH 斜杠命令（line 形如 "/compact" 或 "/goal 新目标"）。
 *  result.text 是命令自己的回执文案，直接可以展示给用户。 */
export async function executeCommand(
  agentId: string,
  line: string,
  submittedAttachments: unknown[] = [],
): Promise<{ commandId: string; result?: { kind?: string; text?: string } }> {
  return rpc<{ commandId: string; result?: { kind?: string; text?: string } }>(
    'commands/execute',
    { agentId, line, submittedAttachments },
    'none',
  );
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

/** 重命名 DSH 会话（Paseo 的 config.title 回写）。 */
export async function renameSession(sessionId: string, title: string): Promise<{ title: string; seq: number }> {
  return rpc('session/rename', { sessionId, title }, 'request', 10_000);
}
