import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { writeFileSync, readFileSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWebLog,
  defaultWebLogPath,
  webLogCandidates,
  resolveDshEndpoint,
  clearDshEndpointCache,
} from '../../server/dsh-endpoint.mjs';
import { startMockDsh, sendMockTurn } from './mock-dsh.mjs';

// last-good cookie 缓存落在临时目录，别写脏 ~/.cache
process.env.DSH_COOKIE_CACHE = join(mkdtempSync(join(tmpdir(), 'dsh-cookie-cache-')), 'cookie.json');
const tmpCookieCache = () => join(mkdtempSync(join(tmpdir(), 'dsh-cookie-case-')), 'cookie.json');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && extname(specifier) === '' && !String(context.parentURL || '').includes('/node_modules/')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

test('endpoint-1: 解析日志里的最后一个 token 与端口', () => {
  const log = [
    '2026-11-03 10:00:00 dsh web: http://192.168.1.5:8780?token=old',
    '2026-11-03 10:01:00 dsh web: http://10.0.0.2:8799?token=new%2Btoken',
  ].join('\n');
  assert.deepEqual(parseWebLog(log), { token: 'new+token', port: 8799 });
  assert.equal(parseWebLog('nothing here'), null);
});

test('endpoint-2: 默认日志路径与覆盖', () => {
  assert.equal(
    defaultWebLogPath({ platform: 'darwin', home: '/Volumes/Data/example', env: {} }),
    '/Volumes/Data/example/Library/Logs/DeepSeek Harness/dsh-web.log',
  );
  assert.equal(defaultWebLogPath({ platform: 'darwin', home: '/x', env: { DSH_WEB_LOG: '/tmp/log' } }), '/tmp/log');

  const win = webLogCandidates({
    platform: 'win32',
    home: 'C:\\Users\\example',
    env: { APPDATA: 'C:\\Users\\example\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
  });
  assert.ok(win.some((p) => p.includes('Roaming') && p.endsWith('dsh-web.log')));
  assert.ok(win.some((p) => p.includes('Local') && p.endsWith('dsh-web.log')));

  const linux = webLogCandidates({ platform: 'linux', home: '/home/example', env: {} });
  assert.ok(linux.includes('/home/example/.config/DeepSeek Harness/logs/dsh-web.log'));
  assert.ok(linux.includes('/home/example/.local/share/DeepSeek Harness/logs/dsh-web.log'));
});

test('endpoint-2b: userData 兜底路径（stdout 落在 app.getPath("userData")/logs 的版本）', () => {
  const mac = webLogCandidates({ platform: 'darwin', home: '/home/example', env: {} });
  assert.ok(mac.includes('/home/example/Library/Application Support/@deepseek-ai/dsh-desktop/logs/dsh-web.log'));
  assert.ok(mac.some((p) => p.includes('Library/Logs/deepseek-harness/')), '小写应用名也要试');

  const linux = webLogCandidates({ platform: 'linux', home: '/home/example', env: {} });
  assert.ok(linux.includes('/home/example/.config/@deepseek-ai/dsh-desktop/logs/dsh-web.log'));

  const win = webLogCandidates({ platform: 'win32', home: 'C:\\Users\\example', env: {} });
  assert.ok(win.some((p) => p.includes('@deepseek-ai/dsh-desktop')), 'Windows 也要有 userData 兜底');
});

test('endpoint-3: 显式 env 覆盖优先', async () => {
  const ep = await resolveDshEndpoint({ env: { DSH_BASE: 'http://127.0.0.1:1', DSH_MUX: 'ws://127.0.0.1:2/mux', DSH_COOKIE: 'c=1' } });
  assert.deepEqual(ep, { base: 'http://127.0.0.1:1', mux: 'ws://127.0.0.1:2/mux', cookie: 'c=1', source: 'env' });
});

test('endpoint-4: 没有日志时回退 8781', async () => {
  const ep = await resolveDshEndpoint({
    env: {},
    logPath: '/nonexistent/dsh-web.log',
    cookieCachePath: tmpCookieCache(), // 隔离：不读真实 ~/.cache 的 last-good
  });
  assert.equal(ep.source, 'legacy-fallback');
  assert.equal(ep.base, 'http://127.0.0.1:8781');
});

test('endpoint-5: 日志 token 换 cookie，端口改写为 127.0.0.1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-endpoint-'));
  const logPath = join(dir, 'dsh-web.log');
  writeFileSync(logPath, 'dsh web: http://192.168.1.9:8799?token=tok123\n');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response('', { status: 302, headers: { 'set-cookie': 'dsh-auth-abc=xyz; Path=/' } });
  };
  const ep = await resolveDshEndpoint({ env: {}, logPath, fetchImpl, cookieCachePath: tmpCookieCache() });
  assert.equal(ep.base, 'http://127.0.0.1:8799');
  assert.equal(ep.mux, 'ws://127.0.0.1:8799/api/remote.mux');
  assert.equal(ep.cookie, 'dsh-auth-abc=xyz');
  assert.equal(ep.source, 'discovered');
  assert.ok(calls[0].includes('/?token=tok123'));
});

test('endpoint-7: cookie 变化后 401 → 重新换 cookie 重试', async (t) => {
  const mock = await startMockDsh(() => {}, { requireCookie: 'dsh-auth-a=1' });
  const dir = mkdtempSync(join(tmpdir(), 'dsh-endpoint-rotate-'));
  const logPath = join(dir, 'dsh-web.log');
  writeFileSync(logPath, `dsh web: http://192.168.1.9:${mock.port}?token=tok-rotate\n`);
  process.env.DSH_WEB_LOG = logPath;
  delete process.env.DSH_BASE;
  delete process.env.DSH_MUX;
  delete process.env.DSH_COOKIE;
  clearDshEndpointCache();
  t.after(() => mock.close());

  const { createProvider } = await import('../../server/provider.ts');
  const conn = await createProvider().connect({});
  const events = [];
  conn.onEvent((e) => events.push(e));
  const waitFor = async (pred, ms = 6000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timeout');
  };

  await conn.send({ type: 'sessions', requestId: 'r1', limit: 5 });
  await waitFor((e) => e.type === 'sessions' && e.requestId === 'r1');

  mock.setCookie('dsh-auth-b=2');
  await conn.send({ type: 'sessions', requestId: 'r2', limit: 5 });
  const r2 = await waitFor((e) => e.type === 'sessions' && e.requestId === 'r2');
  assert.equal(r2.sessions.length, 0);
});

test('endpoint-6: cookie 鉴权的 mock DSH 端到端（发现 → 换 cookie → HTTP+WS）', async (t) => {
  const mock = await startMockDsh((ws, streamId) => sendMockTurn(ws, streamId), {
    requireCookie: 'dsh-auth-test=1',
  });
  const dir = mkdtempSync(join(tmpdir(), 'dsh-endpoint-e2e-'));
  const logPath = join(dir, 'dsh-web.log');
  writeFileSync(logPath, `dsh web: http://192.168.1.9:${mock.port}?token=tok-e2e\n`);
  process.env.DSH_WEB_LOG = logPath;
  delete process.env.DSH_BASE;
  delete process.env.DSH_MUX;
  delete process.env.DSH_COOKIE;
  clearDshEndpointCache();
  t.after(() => mock.close());

  const { createProvider } = await import('../../server/provider.ts');
  const conn = await createProvider().connect({});
  const events = [];
  conn.onEvent((e) => events.push(e));

  await conn.send({ type: 'session.open', requestId: 'r1', sessionId: 'p1', config: { cwd: '/tmp' }, history: 'skip' });
  await conn.send({
    type: 'session.prompt', sessionId: 'p1',
    prompt: { clientMessageId: 'c1', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hello' }] } },
  });
  const start = Date.now();
  while (Date.now() - start < 8000 &&
    !events.some((e) => e.type === 'session.prompt_result' && e.result?.type === 'completed')) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const result = events.find((e) => e.type === 'session.prompt_result' && e.result?.type === 'completed');
  assert.ok(result, 'prompt_result(completed) expected');
  assert.equal(result.result.type, 'completed');
  const text = events.filter((e) => e.type === 'timeline.item' && e.item.type === 'assistant_message')
    .map((e) => e.item.text).join('');
  assert.equal(text, 'mock-answer');
});


test('endpoint-8: 依次尝试多个日志候选，跳过不存在的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-endpoint-multi-'));
  const logPath = join(dir, 'dsh-web.log');
  writeFileSync(logPath, 'dsh web: http://192.168.1.9:8799?token=tok-multi\n');
  const fetchImpl = async () => new Response('', { status: 302, headers: { 'set-cookie': 'dsh-auth-m=1; Path=/' } });
  const ep = await resolveDshEndpoint({
    env: {},
    logPaths: [join(dir, 'missing.log'), logPath],
    fetchImpl,
    cookieCachePath: tmpCookieCache(),
  });
  assert.equal(ep.source, 'discovered');
  assert.equal(ep.logPath, logPath);
  assert.equal(ep.base, 'http://127.0.0.1:8799');
});

test('endpoint-9: token 已失效（401）→ 回落 last-good cookie，探活通过才用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cookie-fallback-'));
  const logPath = join(dir, 'dsh-web.log');
  const cacheFile = join(dir, 'cookie.json');
  writeFileSync(logPath, 'dsh web: http://192.168.1.9:8799?token=stale\n');
  writeFileSync(cacheFile, JSON.stringify({ cookie: 'dsh-auth-good=1', base: 'http://127.0.0.1:8799', at: 1 }));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), cookie: init.headers?.cookie });
    if (String(url).includes('?token=')) return new Response('', { status: 401 });
    return new Response('', { status: init.headers?.cookie === 'dsh-auth-good=1' ? 200 : 401 });
  };
  const ep = await resolveDshEndpoint({ env: {}, logPath, fetchImpl, cookieCachePath: cacheFile });
  assert.equal(ep.source, 'cookie-cache');
  assert.equal(ep.cookie, 'dsh-auth-good=1');
  assert.equal(ep.base, 'http://127.0.0.1:8799');
  assert.equal(ep.mux, 'ws://127.0.0.1:8799/api/remote.mux');
  assert.ok(calls.some((c) => c.url.includes('?token=stale')));
  assert.ok(calls.some((c) => c.url.endsWith('/') && c.cookie === 'dsh-auth-good=1'));
});

test('endpoint-10: token 失效且 last-good 探活也失败 → discovered-no-cookie', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cookie-dead-'));
  const logPath = join(dir, 'dsh-web.log');
  const cacheFile = join(dir, 'cookie.json');
  writeFileSync(logPath, 'dsh web: http://192.168.1.9:8799?token=stale\n');
  writeFileSync(cacheFile, JSON.stringify({ cookie: 'dsh-auth-dead=1', base: 'http://127.0.0.1:8799', at: 1 }));
  const fetchImpl = async () => new Response('', { status: 401 });
  const ep = await resolveDshEndpoint({ env: {}, logPath, fetchImpl, cookieCachePath: cacheFile });
  assert.equal(ep.source, 'discovered-no-cookie');
  assert.equal(ep.cookie, undefined);
});

test('endpoint-11: 日志里完全没有 token（open -a 启动）→ 用 last-good cookie 连 8780', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cookie-notoken-'));
  const cacheFile = join(dir, 'cookie.json');
  writeFileSync(cacheFile, JSON.stringify({ cookie: 'dsh-auth-good=1', at: 1 }));
  const probed = [];
  const fetchImpl = async (url, init = {}) => {
    probed.push({ url: String(url), cookie: init.headers?.cookie });
    return new Response('', { status: init.headers?.cookie === 'dsh-auth-good=1' ? 200 : 401 });
  };
  const ep = await resolveDshEndpoint({ env: {}, logPath: join(dir, 'none.log'), fetchImpl, cookieCachePath: cacheFile });
  assert.equal(ep.source, 'cookie-cache');
  assert.equal(ep.base, 'http://127.0.0.1:8780');
  assert.equal(ep.mux, 'ws://127.0.0.1:8780/api/remote.mux');
  assert.equal(probed[0].cookie, 'dsh-auth-good=1');
});

test('endpoint-12: 没有 token 且缓存也失效 → 仍然走 legacy 8781', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cookie-legacy-'));
  const cacheFile = join(dir, 'cookie.json');
  writeFileSync(cacheFile, JSON.stringify({ cookie: 'dsh-auth-dead=1', at: 1 }));
  const fetchImpl = async () => new Response('', { status: 401 });
  const ep = await resolveDshEndpoint({ env: {}, logPath: join(dir, 'none.log'), fetchImpl, cookieCachePath: cacheFile });
  assert.equal(ep.source, 'legacy-fallback');
  assert.equal(ep.base, 'http://127.0.0.1:8781');
});

test('endpoint-13: 换到新 cookie 后落盘（0600）作为下次 last-good', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cookie-persist-'));
  const logPath = join(dir, 'dsh-web.log');
  const cacheFile = join(dir, 'nested', 'cookie.json');
  writeFileSync(logPath, 'dsh web: http://192.168.1.9:8799?token=fresh\n');
  const fetchImpl = async () => new Response('', { status: 303, headers: { 'set-cookie': 'dsh-auth-new=9; Path=/' } });
  const ep = await resolveDshEndpoint({ env: {}, logPath, fetchImpl, cookieCachePath: cacheFile });
  assert.equal(ep.source, 'discovered');
  assert.equal(ep.cookie, 'dsh-auth-new=9');
  const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.equal(saved.cookie, 'dsh-auth-new=9');
  assert.equal(saved.base, 'http://127.0.0.1:8799');
  assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
});
