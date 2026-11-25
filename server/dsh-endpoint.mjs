import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 8780;
const LEGACY_BASE = 'http://127.0.0.1:8781';
const LEGACY_MUX = 'ws://127.0.0.1:8781/api/remote.mux';
const TOKEN_RE = /dsh web:\s*(http:\/\/[^?\s]+)\?token=([^\s]+)/g;

/**
 * last-good cookie 落盘位置（0600）。
 * 背景（2026-11-20）：DSH 桌面端从 Dock / `open -a` 启动时 stdout 不接日志，
 * 新 launch token 不落 dsh-web.log，日志里那条是旧的 → 交换 401 → 插件失联。
 * 但 dsh-auth cookie 已实测跨 DSH 重启稳定（见 ~/.cache/dsh-fastlane.json 的
 * 11-16 cookie 在 11-20 仍 200），所以换不到 cookie 时可以回落到上次成功的那枚，
 * 用一次 GET / 探活确认它还有效再用。
 */
const DEFAULT_COOKIE_CACHE = path.join(os.homedir(), '.cache', 'dsh-provider-cookie.json');

function cookieCachePath(env) {
  // env 显式传入时优先它；否则回落到进程环境（测试/嵌入式调用会传空 env）
  return env?.DSH_COOKIE_CACHE || process.env.DSH_COOKIE_CACHE || DEFAULT_COOKIE_CACHE;
}

/** 读 last-good cookie；结构不对就当没有。 */
function readCookieCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw.cookie === 'string' && raw.cookie.startsWith('dsh-auth-')) {
      return { cookie: raw.cookie, base: typeof raw.base === 'string' ? raw.base : undefined, at: raw.at };
    }
  } catch {}
  return null;
}

/** 写 last-good cookie；失败不影响主流程。 */
function writeCookieCache(file, cookie, base) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ cookie, base, at: Date.now() }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {}
}

/** 用 cookie 探一次 GET /：2xx/3xx 视为有效（DSH 无效 cookie 回 401）。 */
async function probeCookie({ base, cookie, fetchImpl = fetch, timeoutMs = 3000 }) {
  try {
    const res = await fetchImpl(`${base}/`, {
      headers: { cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

const muxFor = (port) => `ws://127.0.0.1:${port}/api/remote.mux`;

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
  // Electron 的 app.getPath('logs')：macOS 是 ~/Library/Logs/<app>，
  // Windows 是 %APPDATA%\<app>\logs，Linux 是 $XDG_CONFIG_HOME/<app>/logs。
  // 部分版本把 stdout 落在 userData 下（app.getPath('userData')/logs），这里一并给。
  const APP_NAMES = ['DeepSeek Harness', 'deepseek-harness'];
  const USERDATA = path.join('@deepseek-ai', 'dsh-desktop', 'logs', 'dsh-web.log');
  if (env.DSH_WEB_LOG) out.push(env.DSH_WEB_LOG);
  if (platform === 'darwin') {
    for (const name of APP_NAMES) out.push(path.join(home, 'Library', 'Logs', name, 'dsh-web.log'));
    out.push(path.join(home, 'Library', 'Application Support', USERDATA));
  } else if (platform === 'win32') {
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    for (const name of APP_NAMES) {
      out.push(path.join(roaming, name, 'logs', 'dsh-web.log'));
      out.push(path.join(local, name, 'logs', 'dsh-web.log'));
    }
    out.push(path.join(roaming, USERDATA));
    out.push(path.join(local, USERDATA));
  } else {
    const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const name of APP_NAMES) {
      out.push(path.join(config, name, 'logs', 'dsh-web.log'));
      out.push(path.join(home, '.local', 'share', name, 'logs', 'dsh-web.log'));
    }
    out.push(path.join(config, USERDATA));
  }
  return [...new Set(out)];
}

/** 人类可读的候选清单（发现失败时写进插件日志，方便用户照着设 DSH_WEB_LOG）。 */
export function describeWebLogCandidates(opts = {}) {
  return webLogCandidates(opts);
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
 * 优先级：DSH_BASE/DSH_MUX 显式覆盖 → 日志 token + cookie 交换
 *   → last-good cookie（探活通过才用）→ 旧的 8781 兜底。
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

  const cacheFile = opts.cookieCachePath || cookieCachePath(env);
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
    // 日志里没有 token（典型：DSH 从 Dock/open -a 启动）→ 先试 last-good cookie
    const cached = readCookieCache(cacheFile);
    if (cached) {
      const base = cached.base || `http://127.0.0.1:${DEFAULT_PORT}`;
      const port = Number(base.split(':').pop()) || DEFAULT_PORT;
      if (await probeCookie({ base, cookie: cached.cookie, fetchImpl: opts.fetchImpl, timeoutMs: opts.exchangeTimeoutMs })) {
        console.error('[dsh] no launch token; using last-good cookie');
        return { base, mux: muxFor(port), cookie: cached.cookie, source: 'cookie-cache' };
      }
    }
    console.error(`[dsh] no launch token in ${candidates.length} candidate log(s); set DSH_WEB_LOG to override (tried: ${candidates.join(', ')})`);
    return { base: LEGACY_BASE, mux: LEGACY_MUX, cookie: env.DSH_COOKIE, source: 'legacy-fallback' };
  }

  const base = `http://127.0.0.1:${parsed.port}`;
  let cookie = env.DSH_COOKIE;
  let source = env.DSH_COOKIE ? 'env-cookie' : 'discovered';
  let minted = false;
  if (!cookie) {
    try {
      cookie = await exchangeToken({ base, token: parsed.token, fetchImpl: opts.fetchImpl, timeoutMs: opts.exchangeTimeoutMs });
      minted = Boolean(cookie);
    } catch {}
  }
  if (minted) {
    // token 新鲜可用 → 落盘作为下次的 last-good
    writeCookieCache(cacheFile, cookie, base);
  } else if (!cookie) {
    // 日志 token 已失效（被轮换/已消费）→ 回落 last-good cookie，探活后才算数
    const cached = readCookieCache(cacheFile);
    if (cached && await probeCookie({ base, cookie: cached.cookie, fetchImpl: opts.fetchImpl, timeoutMs: opts.exchangeTimeoutMs })) {
      console.error('[dsh] token exchange failed; using last-good cookie');
      cookie = cached.cookie;
      source = 'cookie-cache';
    }
  }
  return {
    base,
    mux: muxFor(parsed.port),
    cookie,
    source: cookie ? source : 'discovered-no-cookie',
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
