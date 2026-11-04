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

/**
 * DSH web 日志候选位置。依据官方桌面文档：macOS 用 ~/Library/Logs/DeepSeek Harness；
 * Windows / Linux 用 application userData 下的 logs（Electron app.getPath('logs')）。
 * 应用目录名在不同版本可能是 "DeepSeek Harness" 或 "deepseek-harness"。
 */
export function webLogCandidates({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const out = [];
  if (env.DSH_WEB_LOG) out.push(env.DSH_WEB_LOG);
  if (platform === 'darwin') {
    out.push(path.join(home, 'Library', 'Logs', 'DeepSeek Harness', 'dsh-web.log'));
  } else if (platform === 'win32') {
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    out.push(path.join(roaming, 'DeepSeek Harness', 'logs', 'dsh-web.log'));
    out.push(path.join(roaming, 'deepseek-harness', 'logs', 'dsh-web.log'));
    out.push(path.join(local, 'DeepSeek Harness', 'logs', 'dsh-web.log'));
  } else {
    const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
    out.push(path.join(config, 'DeepSeek Harness', 'logs', 'dsh-web.log'));
    out.push(path.join(config, 'deepseek-harness', 'logs', 'dsh-web.log'));
    out.push(path.join(home, '.local', 'share', 'DeepSeek Harness', 'logs', 'dsh-web.log'));
    out.push(path.join(home, '.local', 'share', 'deepseek-harness', 'logs', 'dsh-web.log'));
  }
  return [...new Set(out)];
}

/** 默认取第一个候选（兼容旧调用）；实际解析会依次尝试全部候选。 */
export function defaultWebLogPath(opts = {}) {
  return webLogCandidates(opts)[0];
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

  const candidates = opts.logPaths
    || (opts.logPath
      ? [opts.logPath]
      : webLogCandidates({ platform: opts.platform, home: opts.home, env }));
  let parsed = null;
  let logPath;
  for (const p of candidates) {
    try {
      const found = parseWebLog(fs.readFileSync(p, 'utf8'));
      if (found) { parsed = found; logPath = p; break; }
    } catch {}
  }
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
