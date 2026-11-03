#!/usr/bin/env node
/**
 * dsh-acp-server —— 把 DSH 包装成一个标准 ACP agent（stdio JSON-RPC）。
 *
 * 动机：DSH 自带 ACP 实现，但只以**库**的形式（dsh-acp / dsh-acp-app 无 bin）。
 * Paseo 的 runAcpProvider() 需要一个可 launch 的命令 → 本文件补这一层。
 *
 * 底层复用已调通的 DSH 接口：
 *   会话创建  POST /api/session/create   (args.request.cwd)
 *   发消息    POST /api/session/prompt   (args.request.{requestId,sessionId,mode,content,clientTimeZone})
 *   历史/增量 ws /api/remote.mux  endpoint=session/follow → snapshot.records[].event
 *
 * 协议：ACP（Agent Client Protocol）—— initialize / session/new / session/prompt / session/load / session/cancel / session/close
 * 输出：session/update（agent_thought_chunk / agent_message_chunk / tool_call / tool_call_update）
 */
import zlib from 'node:zlib';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import { createTurnState } from './server/turn-state.mjs';
import { followSession, readSnapshot } from './server/dsh-follow.mjs';
import { acpUpdates, toolResultUpdate, acpUsageUpdate, contentOf } from './server/acp-map.mjs';
import { acpConfigOptions, parseModelId, sessionModelRef, contextWindowOf } from './server/model-catalog.mjs';
const LOG='/tmp/dsh-acp.log';
const log=(d)=>fs.appendFileSync(LOG, new Date().toISOString()+' '+d+'\n');

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:8781';

async function rpc(method, args, wrap = 'request') {
  const body = {
    type: 'client-request',
    rpcId: `a${Date.now()}`,
    method,
    // 实测：session/list 用 _request，session/create 等用 request，modelCatalog 裸参数
    payload: { args: wrap === 'none' ? args : { [wrap]: args } },
  };
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let text;
  try { text = zlib.brotliDecompressSync(buf).toString('utf8'); } catch { text = buf.toString('utf8'); }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`dsh ${method}: HTTP ${res.status} ${text.trim().slice(0, 200)}`);
  }
  if (!j?.result?.ok) throw new Error(`dsh ${method}: ${JSON.stringify(j?.result?.error)}`);
  return j.result.value;
}

const createSession = async (cwd) => (await rpc('session/create', { cwd })).sessionId;
const promptSession = (sessionId, content, mode = 'queue') =>
  rpc('session/prompt', {
    requestId: crypto.randomUUID(), sessionId, mode,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    clientTimeZone: 'Asia/Shanghai',
  });
const selectModelRpc = (sessionId, provider, model, reasoningEffort) =>
  rpc('session/selectModel', {
    sessionId, provider, model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }, 'request');

// ---- 模型目录 / 上下文窗口（展示用增强，失败不阻断对话） ----
let catalogCache = null;
async function loadCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.value;
  const value = await rpc('session/modelCatalog', {}, 'none');
  catalogCache = { at: Date.now(), value };
  return value;
}
async function listSessionsSafe() {
  const v = await rpc('session/list', {}, '_request');
  return v?.items || [];
}
async function resolveSessionModel(dshId) {
  try {
    const items = await listSessionsSafe();
    const ref = sessionModelRef(items.find((s) => s.sessionId === dshId));
    if (ref) return ref;
  } catch {}
  try {
    const cat = await loadCatalog();
    const d = cat?.default;
    return d?.provider && d.model ? { provider: d.provider, model: d.model } : null;
  } catch {
    return null;
  }
}
const ctxCache = new Map(); // dshSessionId -> { size, at }
async function contextWindowFor(dshId) {
  const hit = ctxCache.get(dshId);
  if (hit && Date.now() - hit.at < 60_000) return hit.size;
  try {
    const items = await listSessionsSafe();
    const size = contextWindowOf(items.find((s) => s.sessionId === dshId));
    if (size) ctxCache.set(dshId, { size, at: Date.now() });
    return size;
  } catch {
    return undefined;
  }
}

/** 应用模型/思考档位变更 → 返回最新 configOptions。 */
async function applyModelSelection(acpId, configId, value) {
  const dshId = sessions.get(acpId) || acpId;
  const cat = await loadCatalog();
  const before = sessionConfig.get(acpId) ?? (await resolveSessionModel(dshId));
  let next;
  if (configId === 'model') {
    const parsed = parseModelId(value);
    if (!parsed) throw new Error(`unknown model id: ${value}`);
    next = {
      provider: parsed.provider,
      model: parsed.model,
      ...(before?.reasoningEffort ? { reasoningEffort: before.reasoningEffort } : {}),
    };
  } else if (configId === 'reasoning_effort') {
    if (!before) throw new Error('current model is unknown');
    next = { ...before, reasoningEffort: String(value) };
  } else {
    throw new Error(`unknown config option: ${configId}`);
  }
  const r = await selectModelRpc(dshId, next.provider, next.model, next.reasoningEffort);
  next = {
    provider: r.selected.provider,
    model: r.selected.model,
    ...(r.selected.reasoningEffort ? { reasoningEffort: r.selected.reasoningEffort } : {}),
  };
  sessionConfig.set(acpId, next);
  return acpConfigOptions(cat, next);
}

/** 一轮：持久 follow + 共享状态机；实时发 reasoning / text / tool 更新。 */
async function streamTurn(acpId, dshId, text, token, content) {
  const follow = followSession(dshId, { assistantStream: true, readyTimeoutMs: 15000 });
  token.follow = follow;
  let snap;
  try {
    snap = await follow.ready;
  } catch (e) {
    // 首帧失败（上游挂/超时）也必须关闭 follow，避免遗留 socket/定时器
    try { follow.close(); } catch {}
    throw e;
  }
  const state = createTurnState({
    promptText: text,
    startSeq: snap.cursor,
    now: Date.now(),
    budgetMs: 120_000,
    // 纯图片消息没有可匹配的文本，跳过 echo 阶段
    startPhase: text ? 'waitEcho' : 'running',
  });
  let reason = 'completed';
  let timer = null;
  const preview = { step: '', reasoning: '', text: '', rAcc: new Map(), tAcc: new Map() };

  const update = (u) => notifyAsync('session/update', { sessionId: acpId, update: u });
  const flush = async () => {
    if (!preview.step) return;
    if (preview.reasoning) {
      const t = preview.reasoning;
      preview.reasoning = '';
      preview.rAcc.set(preview.step, (preview.rAcc.get(preview.step) || '') + t);
      await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } });
    }
    if (preview.text) {
      const t = preview.text;
      preview.text = '';
      preview.tAcc.set(preview.step, (preview.tAcc.get(preview.step) || '') + t);
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
    }
  };
  const frame = async (f) => {
    if (!f) return;
    // usage 帧不带 turn/step，先于 step 守卫处理；上下文窗口拿不到就不发
    if (f.type === 'chunk' && f.chunk?.type === 'usage') {
      const size = await contextWindowFor(dshId);
      const u = acpUsageUpdate(f.chunk, size);
      if (u) await update(u);
      return;
    }
    // chunk 帧不带 turn/step，沿用 start 帧的 key
    if (f.turn != null && f.step != null) {
      const key = `${f.turn}:${f.step}`;
      if (preview.step && key !== preview.step) await flush();
      preview.step = key;
    }
    if (!preview.step) return;
    if (f.type === 'chunk') {
      const c = f.chunk || {};
      const t = typeof c.text === 'string' ? c.text : '';
      if (c.type === 'reasoning-delta' && t) {
        preview.reasoning += t;
        if (preview.reasoning.length >= 80) await flush();
      } else if (c.type === 'text-delta' && t) {
        preview.text += t;
        if (preview.text.length >= 80) await flush();
      } else if (c.type === 'block-end' || c.type === 'finish') {
        await flush();
      }
    } else if (f.type === 'end') {
      await flush();
    }
  };
  const handleActions = async (actions) => {
    for (const a of actions) {
      if (a.type === 'timeline') {
        await flush();
        const ev = a.event;
        const key = `${ev.data?.turn}:${ev.data?.step}`;
        if (ev.type === 'assistant/message') {
          for (const u of acpUpdates(ev)) {
            if (u.sessionUpdate === 'agent_message_chunk' && preview.tAcc.has(key)) continue;
            if (u.sessionUpdate === 'agent_thought_chunk' && preview.rAcc.has(key)) continue;
            await update(u);
          }
        } else if (ev.type === 'tool/call') {
          for (const u of acpUpdates(ev)) await update(u);
        } else if (ev.type === 'tool/result') {
          await update(toolResultUpdate(ev));
        } else if (ev.type === 'todo/write') {
          for (const u of acpUpdates(ev)) await update(u);
        }
      } else if (a.type === 'notice') {
        log(`turn notice: ${a.message}`);
      } else if (a.type === 'done') {
        reason = a.reason;
      }
    }
  };

  try {
    await handleActions(state.onSnapshot(snap));
    await promptSession(dshId, content ?? text);
    let ticking = false;
    timer = setInterval(async () => {
      if (ticking) return;
      ticking = true;
      try {
        await handleActions(state.onTick(Date.now()));
        if (state.phase === 'done' || token.cancelled) { try { follow.close(); } catch {} }
      } finally {
        ticking = false;
      }
    }, 1000);

    for await (const msg of follow) {
      if (msg.kind === 'event') await handleActions(state.onEvent(msg.event));
      else if (msg.kind === 'assistant') await frame(msg.frame);
      else if (msg.kind === 'snapshot') await handleActions(state.onSnapshot(msg));
      else if (msg.kind === 'reset' || msg.kind === 'truncated' || msg.kind === 'gap') {
        log(`follow ${msg.kind} ${JSON.stringify(msg)}`);
      } else if (msg.kind === 'unknown') {
        log(`unknown frame ${msg.valueType}`);
      } else if (msg.kind === 'error') {
        log(`follow error ${String(msg.error)}`);
      }
      if (state.phase === 'done' || token.cancelled) break;
    }
  } finally {
    if (timer) clearInterval(timer);
    await flush();
    try { follow.close(); } catch {}
  }
  if (token.cancelled) reason = 'canceled';
  return reason === 'completed' ? 'end_turn' : 'cancelled';
}

// ---- stdio JSON-RPC ----
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
/** 背压版 write：缓冲区满时等 drain，避免长回放把 stdio 管道灌爆。 */
const sendAsync = (o) => new Promise((resolve) => {
  if (process.stdout.write(JSON.stringify(o) + '\n')) resolve();
  else process.stdout.once('drain', resolve);
});
const notifyAsync = (method, params) => sendAsync({ jsonrpc: '2.0', method, params });
const reply = (id, result) => { log('>> id='+id+' '+JSON.stringify(result).slice(0,200)); send({ jsonrpc: '2.0', id, result }); };
const fail = (id, message) => { log('!! id='+id+' '+message.slice(0,200)); send({ jsonrpc: '2.0', id, error: { code: -32000, message } }); };

const sessions = new Map();   // acpSessionId -> dshSessionId
const sessionConfig = new Map(); // acpSessionId -> {provider, model, reasoningEffort?}
const activeTurns = new Map(); // acpSessionId -> { cancelled, follow }

rl.on('line', async (line) => {
  log('<< ' + line.slice(0,300));
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        });
      case 'session/new': {
        const cwd = params?.cwd || process.env.DSH_DEFAULT_CWD || os.homedir();
        const dshId = await createSession(cwd);
        // 直接用 DSH 的 sessionId 作为 ACP sessionId：
        // Paseo 可能为每次连接起新进程，内存映射不可靠 → 会话 id 自带还原能力
        sessions.set(dshId, dshId);
        // 模型选择走 ACP 的 configOptions（category=model / thought_level）
        let configOptions = [];
        try {
          const cat = await loadCatalog();
          const d = cat?.default;
          const current = d?.provider && d.model ? { provider: d.provider, model: d.model } : null;
          if (current) sessionConfig.set(dshId, current);
          configOptions = acpConfigOptions(cat, current);
        } catch (e) {
          log('catalog unavailable ' + String(e).slice(0, 120));
        }
        return reply(id, { sessionId: dshId, ...(configOptions.length ? { configOptions } : {}) });
      }
      case 'session/prompt': {
        const acpId = params?.sessionId;
        const dshId = sessions.get(acpId) || acpId;
        const { blocks, text } = contentOf(params?.prompt);
        if (!blocks.length) return reply(id, { stopReason: 'refusal' });
        const token = { cancelled: false };
        activeTurns.set(acpId, token);
        try {
          const stop = await streamTurn(acpId, dshId, text, token, blocks);
          return reply(id, { stopReason: stop });
        } finally {
          if (activeTurns.get(acpId) === token) activeTurns.delete(acpId);
        }
      }
      case 'session/load': {
        // 历史回放：ACP 的 session/load —— 拉 DSH 快照并逐条发 session/update。
        // 长会话（实测 951 行）分段发送：每 CHUNK 条让出事件循环并等 stdout drain。
        const dshId = params?.sessionId;
        const snap = await readSnapshot(dshId, 20000);
        const evs = snap.events;
        const CHUNK = Math.max(1, Number(process.env.DSH_ACP_REPLAY_CHUNK) || 50);
        log(`load ${dshId} → ${evs.length} events (chunk=${CHUNK}, hasMore=${snap.hasMore})`);
        let n = 0;
        for (const ev of evs) {
          const chunks = acpUpdates(ev);
          for (const update of chunks) {
            await notifyAsync('session/update', { sessionId: dshId, update });
            n++;
            if (n % CHUNK === 0) await new Promise((r) => setImmediate(r));
          }
        }
        log(`load replay ${n} updates`);
        // 回放完再告诉客户端会话的模型状态（Paseo 的 loadSession 响应里读 configOptions）
        let configOptions = [];
        try {
          sessions.set(dshId, dshId);
          const cat = await loadCatalog();
          const current = await resolveSessionModel(dshId);
          if (current) sessionConfig.set(dshId, current);
          configOptions = acpConfigOptions(cat, current);
        } catch (e) {
          log('load config unavailable ' + String(e).slice(0, 120));
        }
        return reply(id, configOptions.length ? { configOptions } : {});
      }
      case 'session/set_config_option': {
        const configOptions = await applyModelSelection(params?.sessionId, params?.configId, params?.value);
        return reply(id, { configOptions });
      }
      case 'session/set_model': {
        // ACP 旧版（SDK < 0.4）的模型切换方法；Paseo 0.14 走 config option
        const configOptions = await applyModelSelection(params?.sessionId, 'model', params?.modelId);
        return reply(id, { configOptions });
      }
      case 'session/cancel': {
        const acpId = params?.sessionId;
        const dshId = sessions.get(acpId) || acpId;
        const token = activeTurns.get(acpId);
        if (token) {
          token.cancelled = true;
          try { token.follow?.close(); } catch {}
        }
        try {
          await rpc('session/cancel', { sessionId: dshId }, 'request');
        } catch (e) {
          log('cancel err ' + String(e).slice(0, 120));
        }
        return;   // 通知，无响应
      }
      case 'session/close': {
        const acpId = params?.sessionId;
        const token = activeTurns.get(acpId);
        if (token) {
          token.cancelled = true;
          try { token.follow?.close(); } catch {}
        }
        activeTurns.delete(acpId);
        sessionConfig.delete(acpId);
        ctxCache.delete(sessions.get(acpId) || acpId);
        return reply(id, {});
      }
      default:
        if (id !== undefined) fail(id, `unsupported method: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) fail(id, String(e).slice(0, 300));
  }
});
