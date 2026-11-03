import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 8780;
const LEGACY_BASE = 'http://127.0.0.1:8781';
const LEGACY_MUX = 'ws://127.0.0.1:8781/api/remote.mux';
const TOKEN_RE = /dsh web:\s*(http:\/\/[^?\s]+)\?token=([^\s]+)/g;

/** 解析 DSH web 日志里的最后一个 launch token 与端口；没有则返回 null。 */
export function parseWebLog(text) {
  let last;
  for (const m of String(text || '').matchAll(TOKEN_RE)) last = m;
  if (!last) return null;
  let port = DEFAULT_PORT;
  try {
    port = Number(new URL(last[1]).port) || DEFAULT_PORT;
  } catch {}
  return { token: decodeURIComponent(last[2]), port };
}

/** DSH web 日志的默认位置（可用 DSH_WEB_LOG 覆盖）。 */
export function defaultWebLogPath({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (env.DSH_WEB_LOG) return env.DSH_WEB_LOG;
  if (platform === 'darwin') return path.join(home, 'Library', 'Logs', 'DeepSeek Harness', 'dsh-web.log');
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'DeepSeek Harness', 'logs', 'dsh-web.log');
  }
  return path.join(home, '.local', 'share', 'DeepSeek Harness', 'dsh-web.log');
}

/** 用 launch token 换 dsh-auth cookie（名称与 authority 绑定，必须整对保留）。 */
export async function exchangeToken({ base, token, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const res = await fetchImpl(`${base}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const pairs = res.headers.getSetCookie?.() || [];
  for (const raw of pairs) {
    const pair = raw.split(';')[0];
    if (pair.startsWith('dsh-auth-')) return pair;
  }
  const raw = res.headers.get('set-cookie') || '';
  for (const part of raw.split(/,\s*(?=dsh-auth-)/)) {
    const pair = part.split(';')[0];
    if (pair.startsWith('dsh-auth-')) return pair;
  }
  return undefined;
}

/**
 * 解析当前可用的 DSH 端点。
 * 优先级：DSH_BASE/DSH_MUX 显式覆盖 → 日志 token + cookie 交换 → 旧的 8781 兜底。
 */
export async function resolveDshEndpoint(opts = {}) {
  const env = opts.env || process.env;
  if (env.DSH_BASE || env.DSH_MUX) {
    return {
      base: env.DSH_BASE || LEGACY_BASE,
      mux: env.DSH_MUX || LEGACY_MUX,
      cookie: env.DSH_COOKIE,
      source: 'env',
    };
  }

  const logPath = opts.logPath || defaultWebLogPath({ platform: opts.platform, home: opts.home, env });
  let text = '';
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {}
  const parsed = parseWebLog(text);
  if (!parsed) {
    return { base: LEGACY_BASE, mux: LEGACY_MUX, cookie: env.DSH_COOKIE, source: 'legacy-fallback' };
  }

  const base = `http://127.0.0.1:${parsed.port}`;
  let cookie = env.DSH_COOKIE;
  if (!cookie) {
    try {
      cookie = await exchangeToken({ base, token: parsed.token, fetchImpl: opts.fetchImpl, timeoutMs: opts.exchangeTimeoutMs });
    } catch {}
  }
  return {
    base,
    mux: `ws://127.0.0.1:${parsed.port}/api/remote.mux`,
    cookie,
    source: cookie ? 'discovered' : 'discovered-no-cookie',
    logPath,
  };
}

let cache = null;
const CACHE_MS = 60_000;
const envKey = (env) => [env.DSH_BASE || '', env.DSH_MUX || '', env.DSH_COOKIE || '', env.DSH_WEB_LOG || ''].join('|');

/** 带 TTL 的端点缓存；env 变化会失效；认证失败时调用方用 clearDshEndpointCache() 强制刷新。 */
export async function getDshEndpoint(opts = {}) {
  const key = envKey(opts.env || process.env);
  if (!opts.force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await resolveDshEndpoint(opts);
  cache = { at: Date.now(), key, value };
  // 只记来源与地址，绝不打印 token / cookie
  console.error(`[dsh] endpoint ${value.source} ${value.base}`);
  return value;
}

export function clearDshEndpointCache() {
  cache = null;
}
