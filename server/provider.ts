/**
 * Paseo provider：DSH（2026-11-02，契约来自 @getpaseo/plugin dist 类型定义）
 *
 * 契约要点（实测+类型）：
 *  · inputs:  catalog / sessions / session.open / session.prompt / session.interrupt / ...
 *  · events:  catalog / sessions / session.opened / session.ready / session.prompt_result / ...
 *  · send() 只报"收到"，结果一律走 onEvent 推**完整快照**
 *  · ProviderSessionSummary = { persistence:{version,data}, cwd, title?, description?, updatedAt?(ISO) }
 */
import { listSessions, promptSession, createSession, interruptSession, probeDsh } from './dsh-client';
import { fetchSessionRecords, followSession, type DshEvent } from './dsh-ws';
import { createTurnState } from './turn-state.mjs';

type Emit = (e: any) => void;

const defaultCwd = () => process.env.DSH_DEFAULT_CWD || process.env.HOME || process.cwd();
const normText = (s: unknown) => String(s ?? '').replace(/\s+/g, '');
let statusCache: { at: number; value: { available: boolean; diagnostic?: string } } | null = null;

export function createProvider() {
  return {
    id: 'dsh',
    label: 'DSH',
    icon: 'icon.svg',

    /** Paseo 用它判断可用性；5 秒缓存，避免频繁探活。 */
    async status() {
      if (statusCache && Date.now() - statusCache.at < 5000) return statusCache.value;
      const r = await probeDsh();
      const value = r.ok
        ? { available: true as const }
        : { available: false as const, diagnostic: r.diagnostic || 'DSH unreachable' };
      statusCache = { at: Date.now(), value };
      return value;
    },

    async connect(_request: any) {
      console.error('[dsh] connect called');
      const listeners: Emit[] = [];
      const openSessions = new Map<string, string>();   // paseoSessionId → dshSessionId
      const activeTurns = new Map<string, AbortController>();
      const emit: Emit = (e) => listeners.forEach((l) => l(e));

      return {
        // ProviderConnection 契约要求（漏了会被判 invalid message）
        version: 1,
        capabilities: ['session.list', 'session.persistence', 'prompt.message'] as const,

        /** 只做接收与分发；结果全部以事件返回。 */
        async send(input: any) {
          console.error('[dsh] INPUT', JSON.stringify(input).slice(0,160));
          try {
            switch (input?.type) {
              case 'catalog':
                emit({
                  type: 'catalog',
                  requestId: input.requestId,
                  catalog: {
                    models: [{
                      id: 'dsh-default',
                      label: 'DSH',
                      description: 'DSH 会话（当前只读：列会话）',
                      isDefault: true,
                    }],
                    modes: [{ id: 'default', label: 'default' }],
                    defaultModel: 'dsh-default',
                    defaultMode: 'default',
                  },
                });
                break;

              case 'sessions': {
                const items = await listSessions();
                await fillMissingTitles(items, input.limit ?? 50);
                console.error('[dsh] sessions fetched', items.length);
                emit({
                  type: 'sessions',
                  requestId: input.requestId,
                  sessions: items.map(toSummary).slice(0, input.limit ?? 50),
                });
                break;
              }

              case 'session.open': {
                const sid = input.sessionId;
                let dshId = input.persistence?.data?.sessionId;
                if (!dshId) {
                  // 新会话：在 DSH 侧建一个，建立映射（否则 prompt 无处可发）
                  dshId = await createSession(String(input.config?.cwd ?? defaultCwd()));
                  console.error('[dsh] created dsh session', dshId);
                }
                openSessions.set(sid, dshId);
                console.error('[dsh] session.open', sid, 'dsh=', dshId, 'history=', input.history);

                emit({
                  type: 'session.opened',
                  requestId: input.requestId,
                  sessionId: sid,
                  capabilities: ['session.list', 'session.persistence', 'prompt.message'],
                  restoration: 'core',
                  persistence: { version: 1, data: { sessionId: dshId } },
                  cwd: String(input.config?.cwd ?? defaultCwd()),
                });

                if (input.history === 'replay' && input.persistence?.data?.sessionId) {
                  const events = await fetchSessionRecords(dshId);
                  console.error('[dsh] replay events', events.length);
                  let n = 0;
                  const pending = new Map<string, any>();
                  for (const ev of events) {
                    for (const item of toTimeline(ev, pending)) {
                      emit({
                        type: 'timeline.item',
                        sessionId: sid,
                        item,
                        timestamp: ev.time ? new Date(ev.time).toISOString() : undefined,
                      });
                      n++;
                    }
                  }
                  console.error('[dsh] timeline items emitted', n);
                }

                emit({ type: 'session.ready', sessionId: sid, requestId: input.requestId });
                console.error('[dsh] emitted session.ready');
                break;
              }

              case 'session.prompt': {
                const p = input.prompt || {};
                const text = extractText(p);
                const dshId = openSessions.get(input.sessionId) || input.sessionId;
                console.error('[dsh] prompt RAW', JSON.stringify(input.prompt).slice(0,300)); console.error('[dsh] prompt →', dshId, JSON.stringify(text).slice(0,80));
                if (!text) {
                  emit({
                    type: 'session.prompt_result',
                    sessionId: input.sessionId,
                    clientMessageId: p.clientMessageId ?? '',
                    result: { type: 'failed' },
                  });
                  break;
                }
                if (activeTurns.has(input.sessionId)) {
                  emit({
                    type: 'session.prompt_result',
                    sessionId: input.sessionId,
                    clientMessageId: p.clientMessageId ?? '',
                    result: { type: 'failed', error: { message: 'session busy: a turn is already running', code: 'dsh/busy' } },
                  });
                  break;
                }
                // 持久 follow：snapshot 定基线 → 发 prompt → 消费 event/assistant-stream
                // → turn/end 收工 → 最后才发 prompt_result。
                // 不 await：让 interrupt/close 能在本轮运行期间被处理。
                const ctl = new AbortController();
                activeTurns.set(input.sessionId, ctl);
                void runTurn(input.sessionId, dshId, text, emit, { signal: ctl.signal })
                  .then(({ reason }) => emit({
                    type: 'session.prompt_result',
                    sessionId: input.sessionId,
                    clientMessageId: p.clientMessageId ?? '',
                    result: reason === 'completed'
                      ? { type: 'completed' }
                      : { type: 'failed', error: { message: `turn ${reason}`, code: 'dsh/turn' } },
                  }))
                  .catch((e) => emit({
                    type: 'session.prompt_result',
                    sessionId: input.sessionId,
                    clientMessageId: p.clientMessageId ?? '',
                    result: { type: 'failed', error: { message: errorMessage(e), code: 'dsh/error' } },
                  }))
                  .finally(() => {
                    if (activeTurns.get(input.sessionId) === ctl) activeTurns.delete(input.sessionId);
                  });
                break;
              }

              case 'session.interrupt': {
                const dshId = openSessions.get(input.sessionId) || input.sessionId;
                activeTurns.get(input.sessionId)?.abort();
                await interruptSession(dshId);
                break;
              }

              case 'session.can_stop_runtime':
                emit({
                  type: 'session.can_stop_runtime',
                  requestId: input.requestId,
                  sessionId: input.sessionId,
                  canStop: activeTurns.has(input.sessionId),
                });
                break;

              case 'session.close': {
                activeTurns.get(input.sessionId)?.abort();
                activeTurns.delete(input.sessionId);
                openSessions.delete(input.sessionId);
                emit({ type: 'session.closed', sessionId: input.sessionId });
                console.error('[dsh] session.closed', input.sessionId);
                break;
              }

              case 'session.permission':
                console.error('[dsh] permission response ignored', input.permissionId);
                return;

              default: {
                const message = `unsupported input: ${input?.type}`;
                console.error('[dsh]', message);
                if (input?.requestId) {
                  emit({ type: 'request.failed', requestId: input.requestId, error: { message, code: 'dsh/unsupported' } });
                  return; // 不再补 request.completed
                }
                break;
              }
            }
            if (input?.requestId) {
              emit({ type: 'request.completed', requestId: input.requestId });
              console.error('[dsh] request.completed', input.type);
            }
          } catch (e) {
            const message = errorMessage(e);
            console.error('[dsh] error', message);
            if (input?.requestId) {
              emit({
                type: 'request.failed',
                requestId: input.requestId,
                error: {
                  message,
                  code: 'dsh/error',
                  diagnostic: e instanceof Error ? String(e.stack || '').slice(0, 800) : undefined,
                },
              });
            }
          }
        },

        onEvent(listener: Emit) {
          listeners.push(listener);
          return () => {
            const i = listeners.indexOf(listener);
            if (i >= 0) listeners.splice(i, 1);
          };
        },

        async close() {
          listeners.length = 0;
        },
      };
    },
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function toSummary(s: any) {
  const v = s?.projections?.values ?? {};
  return {
    // DSH 的 sessionId 就是这个 provider 命名空间里的持久化标识
    persistence: { version: 1, data: { sessionId: s.sessionId } },
    cwd: s?.cwd ?? '',
    title: str(v.title) ?? '(无标题)',
    description: str(v.goal?.objective) ?? str(v.goal),
    updatedAt: Number.isFinite(s?.updatedAt) ? new Date(s.updatedAt).toISOString() : undefined,
  };
}


/** assistant/message 是否带正文（tool-call 消息只有 tool-call block，不算回复）。 */
function hasAssistantText(ev: DshEvent): boolean {
  const content = ev?.data?.message?.content;
  return Array.isArray(content) &&
    content.some((c: any) => c && c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0);
}

/** DSH 事件 → Paseo 时间线项。
 * tool/call 先挂起，等 tool/result 到达再合成一条（带输出与状态），避免出现"永远 running"。 */
function toTimeline(ev: DshEvent, pending: Map<string, any>): any[] {
  const d = ev?.data || {};
  const out: any[] = [];
  const texts = (content: any[], keep: string[]) =>
    (Array.isArray(content) ? content : [])
      .filter((c) => c && keep.includes(c.type) && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();

  if (ev.type === 'user/message') {
    const text = texts(d.content, ['text']);
    if (text) out.push({ type: 'user_message', id: d.id || `u-${ev.seq}`, text });
  } else if (ev.type === 'assistant/message') {
    const content = d?.message?.content;
    const t = texts(content, ['text']);
    if (t) out.push({ type: 'assistant_message', id: `a-${ev.seq}`, text: t });
    const r = texts(content, ['reasoning']);
    if (r) out.push({ type: 'reasoning', id: `r-${ev.seq}`, text: r });
  } else if (ev.type === 'tool/call') {
    pending.set(String(d.callId || ev.seq), { d, seq: ev.seq, time: ev.time });
  } else if (ev.type === 'tool/result') {
    const callId = String(d.toolCallId || d?.message?.source?.callId || '');
    const p = pending.get(callId);
    if (p) {
      pending.delete(callId);
      out.push({ type: 'tool_call', id: `t-${p.seq}`, callId,
        ...buildToolCall(p.d, texts(d?.message?.content, ['text'])) });
    }
  }
  return out;
}

/** 按 DSH 工具名映射到 Paseo 的 detail 联合类型。 */
function buildToolCall(d: any, output: string) {
  let args: any = {};
  try {
    args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments || {};
  } catch {
    args = { raw: String(d.arguments ?? '') };
  }
  const name = String(d.name || 'tool');
  const n = name.toLowerCase();
  const file = args.file_path || args.path || args.filePath || '';

  let detail: any;
  if (n.includes('bash') || n.includes('shell') || n.includes('exec')) {
    detail = { type: 'shell', command: String(args.command ?? '').slice(0, 2000),
      output: output.slice(0, 4000), exitCode: null };
  } else if (n === 'read' || n.includes('read_file')) {
    detail = { type: 'read', filePath: String(file), content: output.slice(0, 4000) };
  } else if (n === 'write' || n.includes('write_file')) {
    detail = { type: 'write', filePath: String(file), content: String(args.content ?? '').slice(0, 4000) };
  } else if (n === 'edit' || n.includes('str_replace')) {
    detail = { type: 'edit', filePath: String(file),
      oldString: String(args.old_string ?? ''), newString: String(args.new_string ?? '') };
  } else if (n.includes('grep') || n.includes('search') || n.includes('glob')) {
    detail = { type: 'search', query: String(args.query ?? args.pattern ?? ''),
      content: output.slice(0, 2000) };
  } else {
    detail = { type: 'unknown', input: args, output: output.slice(0, 2000) };
  }
  return { name, detail, status: 'completed', error: null };
}

/** 未拿到 result 的工具：结算成 failed，避免界面永远 running。 */
function settleToolFailure(callId: string, p: any, paseoId: string, emit: Emit, message: string) {
  const built = buildToolCall(p.d, '');
  emit({
    type: 'timeline.item',
    sessionId: paseoId,
    item: {
      type: 'tool_call',
      id: `t-${p.seq}`,
      callId,
      name: built.name,
      detail: built.detail,
      status: 'failed',
      error: { message },
    },
  });
}

function flushPending(pending: Map<string, any>, paseoId: string, emit: Emit) {
  for (const [callId, p] of pending) {
    settleToolFailure(callId, p, paseoId, emit, 'tool result not received before turn end');
  }
  pending.clear();
}

/** 用持久 follow + 共用 turn 状态机跑完一轮；返回 done reason。 */
export async function runTurn(
  paseoId: string,
  dshId: string,
  text: string,
  emit: Emit,
  deps: {
    follow?: typeof followSession;
    prompt?: typeof promptSession;
    now?: () => number;
    tickMs?: number;
    budgetMs?: number;
    echoTimeoutMs?: number;
    toolTimeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ reason: string }> {
  const follow = (deps.follow || followSession)(dshId, { assistantStream: true, readyTimeoutMs: 15_000 });
  const now = deps.now || Date.now;
  const pending = new Map<string, any>();
  const notices = new Set<string>();
  let noticeSeq = 0;
  let reason = 'completed';
  let timer: ReturnType<typeof setInterval> | null = null;

  // assistant-stream 的实时预览：reasoning-delta / text-delta 按块刷出。
  // Paseo daemon 会把连续的 reasoning/assistant 条目按 seq 合并成一条。
  const preview = {
    step: '',
    reasoning: '',
    text: '',
    rSeq: 0,
    tSeq: 0,
    rAcc: new Map<string, string>(),
    tAcc: new Map<string, string>(),
  };
  const flushPreview = () => {
    if (!preview.step) return;
    if (preview.reasoning) {
      const text = preview.reasoning;
      preview.reasoning = '';
      preview.rAcc.set(preview.step, (preview.rAcc.get(preview.step) || '') + text);
      emit({
        type: 'timeline.item',
        sessionId: paseoId,
        item: { type: 'reasoning', id: `rs-${preview.step}-${preview.rSeq++}`, text },
      });
    }
    if (preview.text) {
      const text = preview.text;
      preview.text = '';
      preview.tAcc.set(preview.step, (preview.tAcc.get(preview.step) || '') + text);
      emit({
        type: 'timeline.item',
        sessionId: paseoId,
        item: { type: 'assistant_message', id: `as-${preview.step}-${preview.tSeq++}`, text },
      });
    }
  };
  const handlePreviewFrame = (f: any) => {
    if (!f) return;
    // usage chunk 可能不带 turn/step，先处理再进 step 守卫
    if (f.type === 'chunk' && f.chunk?.type === 'usage') {
      const c = f.chunk;
      const u = c.usage || c.usageMetadata || c;
      const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const usage = {
        inputTokens: num(u.input_tokens ?? u.input ?? u.promptTokenCount),
        cachedInputTokens: num(u.cache_read_input_tokens ?? u.cachedContentTokenCount ?? u.cacheRead),
        outputTokens: num(u.output_tokens ?? u.output ??
          ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0))),
      };
      if (Object.values(usage).some((v) => v != null)) {
        emit({ type: 'session.usage', sessionId: paseoId, usage });
      }
      return;
    }
    // chunk 帧本身不带 turn/step，只有 start 帧带；key 必须沿用 start 的值，
    // 否则会和最终 assistant/message 的 key 对不上（实测曾退化成 "?:?" 导致重复）。
    if (f.turn != null && f.step != null) {
      const key = `${f.turn}:${f.step}`;
      if (preview.step && key !== preview.step) flushPreview();
      preview.step = key;
    }
    if (!preview.step) return;
    if (f.type === 'chunk') {
      const c = f.chunk || {};
      const t = typeof c.text === 'string' ? c.text : '';
      if (c.type === 'reasoning-delta' && t) {
        preview.reasoning += t;
        if (preview.reasoning.length >= 80) flushPreview();
      } else if (c.type === 'text-delta' && t) {
        // 正文攒到 block-end 一次落定：分块合并会在块边界插入换行，破坏最终排版。
        preview.text += t;
      } else if (c.type === 'block-end' || c.type === 'finish') {
        flushPreview();
      }
    } else if (f.type === 'end') {
      flushPreview();
    }
  };

  const onAbort = () => {
    reason = 'canceled';
    try { follow.close(); } catch {}
  };
  deps.signal?.addEventListener('abort', onAbort, { once: true });

  const notice = (message: string, severity: 'info' | 'warning' | 'error' = 'warning') => {
    emit({
      type: 'session.notice',
      sessionId: paseoId,
      notice: { id: `dsh-${now()}-${noticeSeq++}`, severity, title: 'DSH', description: message },
    });
  };

  const handle = (actions: ReturnType<ReturnType<typeof createTurnState>['onTick']>) => {
    for (const a of actions) {
      if (a.type === 'timeline') {
        flushPreview();
        const ev = a.event as DshEvent;
        const key = `${(ev.data as any)?.turn}:${(ev.data as any)?.step}`;
        for (const item of toTimeline(ev, pending)) {
          // 该 step 已有流式预览 → 最终件一律不再发，避免重复。
          if (item.type === 'assistant_message' && preview.tAcc.has(key)) {
            if (normText(item.text) !== normText(preview.tAcc.get(key) || '')) {
              notice(`stream/final 文本不一致（step ${key}），以流式预览为准`);
            }
            continue;
          }
          if (item.type === 'reasoning' && preview.rAcc.has(key)) continue;
          emit({
            type: 'timeline.item',
            sessionId: paseoId,
            item,
            timestamp: ev.time ? new Date(ev.time).toISOString() : undefined,
          });
        }
      } else if (a.type === 'turn') {
        emit({ type: 'session.turn', sessionId: paseoId, turnId: `dsh-turn-${a.turn ?? '?'}`, state: a.state });
      } else if (a.type === 'notice') {
        notice(a.message, a.level);
      } else if (a.type === 'done') {
        reason = a.reason;
      }
    }
  };

  try {
    const snap = await follow.ready.catch((e) => {
      if (deps.signal?.aborted) return null;
      throw e;
    });
    if (!snap) return { reason: 'canceled' };

    const state = createTurnState({
      promptText: text,
      startSeq: snap.cursor,
      now: now(),
      echoTimeoutMs: deps.echoTimeoutMs ?? 15_000,
      budgetMs: deps.budgetMs ?? 120_000,
    });
    handle(state.onSnapshot(snap));
    await (deps.prompt || promptSession)(dshId, text);

    timer = setInterval(() => {
      const at = now();
      for (const [callId, p] of [...pending]) {
        if (p.time && at - p.time > (deps.toolTimeoutMs ?? 60_000)) {
          settleToolFailure(callId, p, paseoId, emit, 'tool result timeout (60s)');
          pending.delete(callId);
        }
      }
      handle(state.onTick(at));
      if (state.phase === 'done') { try { follow.close(); } catch {} }
    }, deps.tickMs ?? 1000);

    for await (const msg of follow) {
      if (msg.kind === 'event') handle(state.onEvent(msg.event));
      else if (msg.kind === 'assistant') {
        handlePreviewFrame(msg.frame);
        handle(state.onAssistantFrame(msg.frame));
      } else if (msg.kind === 'snapshot') handle(state.onSnapshot(msg));
      else if (msg.kind === 'reset' || msg.kind === 'truncated') { /* state 已按 snapshot 发 notice */ }
      else if (msg.kind === 'gap') {
        notice(`重连期间可能丢失事件：seq ${msg.from} → ${msg.to}`);
      } else if (msg.kind === 'unknown') {
        if (!notices.has(msg.valueType)) {
          notices.add(msg.valueType);
          notice(`未知 mux 帧类型：${msg.valueType}`);
        }
      } else if (msg.kind === 'error') {
        console.error('[dsh] follow error', String(msg.error));
        if (!notices.has('follow-error')) {
          notices.add('follow-error');
          notice('DSH 连接中断，正在自动重连');
        }
      }
      if (state.phase === 'done' || deps.signal?.aborted) break;
    }
    if (deps.signal?.aborted) reason = 'canceled';
  } finally {
    deps.signal?.removeEventListener('abort', onAbort);
    if (timer) clearInterval(timer);
    flushPreview();
    try { follow.close(); } catch {}
    flushPending(pending, paseoId, emit);
  }
  return { reason };
}

/** 轮询 DSH 会话，把新增事件按序推给 Paseo（收到助手回复后再多等一轮即收工）。
 *
 * 2026-11-03 修「回复慢一拍」：
 * 原来 lastSeq 恒从 -1 起，等于每次提问都把**整段历史重放一遍** ——
 *   · 用户自己的话被回灌一遍（界面上同一句出现两次）
 *   · 历史里早就有 assistant/message，sawAssistant 立刻为真，
 *     空闲一轮就 break，本次真正的回复还没落库就发了 prompt_result
 *     → 走下一轮提问时才被当作"新事件"补显出来（用户看到的就是"发下一条才看到上一条的回复"）
 * 现在从 baseline 起（本次提问之后），并等自己的 user/message 落库再开始流。
 */
export async function streamNewEvents(
  paseoId: string,
  dshId: string,
  emit: (e: any) => void,
  budgetMs = 60_000,
  startSeq?: number,
  fetch = fetchSessionRecords,
  pollMs = 1200,
) {
  // 护栏（2026-11-03，交接批改 A4 提出）：startSeq 曾经默认 -1，等于"从头重放"，
  // 正是「回复慢一拍」那个 bug 的形态。现在改成必填：漏传就当场炸，
  // 而不是静默重放历史、等到用户发现顺序不对。
  if (startSeq === undefined) {
    throw new Error('streamNewEvents: startSeq 必须显式传入（-1 会导致整段历史重放）');
  }
  let lastSeq = startSeq;
  let idle = 0;
  let sawReplyText = false;
  let sawTurnEnd = false;
  const pending = new Map<string, any>();
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && idle < 10) {
    const events = await fetch(dshId, 10_000).catch(() => [] as DshEvent[]);
    const fresh = events.filter((e) => e.seq > lastSeq);
    if (fresh.length === 0) {
      idle++;
    } else {
      idle = 0;
      for (const ev of fresh) {
        // tool-call 的 assistant/message 没有 text，不算「回复已出现」；
        // 2026-11-03 真机抓到：只看 assistant/message 会在工具调用后误收工。
        if (ev.type === 'assistant/message' && hasAssistantText(ev)) sawReplyText = true;
        if (ev.type === 'turn/end') sawTurnEnd = true;
        for (const item of toTimeline(ev, pending)) {
          emit({
            type: 'timeline.item',
            sessionId: paseoId,
            item,
            timestamp: ev.time ? new Date(ev.time).toISOString() : undefined,
          });
        }
        lastSeq = Math.max(lastSeq, ev.seq);
      }
    }
    // turn/end 是 DSH 的权威收工信号；text+idle 仅作没有 turn/end 的旧版兜底。
    if (sawTurnEnd) break;
    if (sawReplyText && idle >= 5) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  console.error('[dsh] stream ended at seq', lastSeq, 'replyText=', sawReplyText, 'turnEnd=', sawTurnEnd);
}

/** 取会话当前最大 seq —— 作为「本次提问之后」的起点。 */
export async function maxSeqOf(dshId: string, fetch = fetchSessionRecords): Promise<number> {
  const evs = await fetch(dshId, 10_000).catch(() => [] as DshEvent[]);
  return evs.reduce((m, e) => Math.max(m, e.seq ?? -1), -1);
}

/** 等我们自己刚发的那句话落库，返回它的 seq（取其之后为流式起点）。
 *  拿不到就返回期间见到的最大 seq —— 宁可少回放，也不要把用户的话echo一遍。 */
export async function waitForUserEcho(
  dshId: string,
  text: string,
  afterSeq: number,
  budgetMs = 15_000,
  fetch = fetchSessionRecords,
): Promise<number> {
  const needle = text.trim().slice(0, 40);
  const deadline = Date.now() + budgetMs;
  let last = afterSeq;
  while (Date.now() < deadline) {
    const evs = await fetch(dshId, 10_000).catch(() => [] as DshEvent[]);
    for (const ev of evs) {
      if ((ev.seq ?? -1) <= afterSeq) continue;
      last = Math.max(last, ev.seq);
      if (ev.type === 'user/message') {
        const t = (ev.data?.content || [])
          .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join('\n')
          .trim();
        if (needle && (t.includes(needle) || (t && needle.includes(t.slice(0, 40))))) return ev.seq;
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return last;
}

/** 从 Paseo 的 prompt 结构里抽纯文本（实测文本在 prompt.input.content[]） */
function extractText(prompt: any): string {
  if (typeof prompt?.text === 'string') return prompt.text;
  const parts =
    prompt?.input?.content ?? prompt?.content ?? prompt?.message?.content ?? prompt?.blocks ?? [];
  if (!Array.isArray(parts)) return '';
  const raw = parts
    .filter((b: any) => b && (b.type === 'text' || b.type === 'plain_text') && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
  // 去掉 Paseo 注入的 <paseo-system …>…</paseo-system> 包装，只留用户真正说的话
  return raw
    .replace(/<\/?paseo-system[^>]*>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


/** 异常 → 一条可读消息（去掉 "Error: " 前缀），给 Paseo 侧直接展示。 */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error:\s*/, '').slice(0, 300) || 'unknown error';
}

/** 无标题会话补标题：有并发上限地取快照，用首条用户消息（去掉 paseo-system 包装）作标题。
 *  实测（2026-11-03，12 个快照）：并发 12≈8.0s、8≈8.3s、4≈16.1s（分 3 批）。
 *  默认 8 在同样时延下把并发压力降 1/3；可用 DSH_TITLE_CONCURRENCY 覆盖。 */
export async function fillMissingTitles(
  items: any[],
  limit: number,
  fetch = fetchSessionRecords,
  concurrency = Math.max(1, Number(process.env.DSH_TITLE_CONCURRENCY) || 8),
) {
  const targets = items
    .slice(0, Math.max(0, limit))
    .filter((s) => !str(s?.projections?.values?.title))
    .slice(0, 12);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const s = targets[next++];
      try {
        const evs = await fetch(s.sessionId, 8000);
        const first = evs.find((e) => e.type === 'user/message');
        const txt = (first?.data?.content || [])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join(' ')
          .replace(/<paseo-system[^>]*>/g, '')
          .replace(/<\/paseo-system>/g, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (txt) {
          s.projections = s.projections || { values: {} };
          s.projections.values = s.projections.values || {};
          s.projections.values.title = txt.slice(0, 60);
        }
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
}
