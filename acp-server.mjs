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
import { acpUpdates, toolResultUpdate, textOf } from './server/acp-map.mjs';
const LOG='/tmp/dsh-acp.log';
const log=(d)=>fs.appendFileSync(LOG, new Date().toISOString()+' '+d+'\n');

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:8781';

async function rpc(method, args, wrap = 'request') {
  const body = { type: 'client-request', rpcId: `a${Date.now()}`, method, payload: { args: { [wrap]: args } } };
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
const promptSession = (sessionId, text, mode = 'queue') =>
  rpc('session/prompt', {
    requestId: crypto.randomUUID(), sessionId, mode,
    content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai',
  });

/** 一轮：持久 follow + 共享状态机；实时发 reasoning / text / tool 更新。 */
async function streamTurn(acpId, dshId, text, token) {
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
    await promptSession(dshId, text);
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
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
        });
      case 'session/new': {
        const cwd = params?.cwd || process.env.DSH_DEFAULT_CWD || os.homedir();
        const dshId = await createSession(cwd);
        // 直接用 DSH 的 sessionId 作为 ACP sessionId：
        // Paseo 可能为每次连接起新进程，内存映射不可靠 → 会话 id 自带还原能力
        sessions.set(dshId, dshId);
        return reply(id, { sessionId: dshId });
      }
      case 'session/prompt': {
        const acpId = params?.sessionId;
        const dshId = sessions.get(acpId) || acpId;
        const text = textOf(params?.prompt);
        if (!text) return reply(id, { stopReason: 'refusal' });
        const token = { cancelled: false };
        activeTurns.set(acpId, token);
        try {
          const stop = await streamTurn(acpId, dshId, text, token);
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
        return reply(id, {});
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
        return reply(id, {});
      }
      default:
        if (id !== undefined) fail(id, `unsupported method: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) fail(id, String(e).slice(0, 300));
  }
});
