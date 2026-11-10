/**
 * Paseo provider：DSH（2026-11-02，契约来自 Paseo provider 类型定义）
 *
 * 契约要点（实测+类型）：
 *  · inputs:  catalog / sessions / session.open / session.prompt / session.interrupt / ...
 *  · events:  catalog / sessions / session.opened / session.ready / session.prompt_result / ...
 *  · send() 只报"收到"，结果一律走 onEvent 推**完整快照**
 *  · ProviderSessionSummary = { persistence:{version,data}, cwd, title?, description?, updatedAt?(ISO) }
 */
import { listSessions, promptSession, createSession, interruptSession, probeDsh, modelCatalog, selectModel, renameSession, listCommands, executeCommand, sessionProjections } from './dsh-client';
import type { DshModelCatalog, DshPromptBlock } from './dsh-client';
import { fetchSessionRecords, fetchSessionSnapshot, followSession, type DshEvent } from './dsh-ws';
import { getDshEndpoint } from './dsh-endpoint.mjs';
import { createTurnState } from './turn-state.mjs';
import { logDebug, logInfo, logWarn, logError } from './log';
import {
  catalogDefaults,
  encodeModelId,
  parseModelId,
  sessionModelRef,
  toProviderConfig,
  type ModelRef,
} from './model-catalog.mjs';

type Emit = (e: any) => void;

const defaultCwd = () => process.env.DSH_DEFAULT_CWD || process.env.HOME || process.cwd();
const normText = (s: unknown) => String(s ?? '').replace(/\s+/g, '');
let statusCache: { at: number; value: { available: boolean; diagnostic?: string } } | null = null;

/** 与 Paseo 协商的能力（muse/antigravity 等官方 provider 的同款基线，去掉 DSH 没有的
 *  permission / prompt.command：DSH 用 preset 自动执行，且没有命令注册 RPC）。 */
const CAPABILITIES = [
  'session.list',
  'session.persistence',
  'prompt.message',
  'prompt.image',
  'prompt.steer',
  'prompt.command',
  'session.configure',
] as const;

/** 模型目录缓存：Paseo 会在启动/切会话时反复取，60 秒内复用。 */
let catalogCache: { at: number; value: DshModelCatalog } | null = null;
async function loadCatalog(maxAgeMs = 60_000): Promise<DshModelCatalog> {
  if (catalogCache && Date.now() - catalogCache.at < maxAgeMs) return catalogCache.value;
  const value = await modelCatalog();
  catalogCache = { at: Date.now(), value };
  return value;
}

/** 重连用的端点解析器（2026-11-10）：DSH 桌面端重启会换 launch token → 新 cookie，
 *  端口也可能变。只复用首连的 url/cookie 会永远接不回去。返回 null 表示沿用旧端点。 */
/** 不支持图片输入的模型（`provider::model`）。DSH 的 modelCatalog 没有能力位，
 *  只能从 `session/attachment-invalid` 反向学习；学到之后同类请求直接快速失败，
 *  不用再让整轮跑到 DSH 才报错（2026-11-08 真机一例）。 */
/** Paseo 的 session.usage 是「整块替换 lastUsage」：tokens（step chunk）与上下文占用（projections）
 *  必须合并成同一份发出去，否则后发的一方会把先发的字段清掉（面板忽有忽无就是这么来的）。 */
const lastUsageBySession = new Map<string, Record<string, any>>();
function emitUsage(emit: Emit, sessionId: string, patch: Record<string, any> | null | undefined) {
  if (!patch || !Object.keys(patch).length) return;
  const next = { ...(lastUsageBySession.get(sessionId) || {}), ...patch };
  lastUsageBySession.set(sessionId, next);
  emit({ type: 'session.usage', sessionId, usage: next });
}

const imageUnsupported = new Set<string>();
const ATTACHMENT_REJECTED = /attachment-invalid|does not support image/i;

async function endpointResolver(): Promise<{ url: string; connect: (url: string) => any } | null> {
  const ep = await getDshEndpoint({ force: true }).catch(() => null);
  if (!ep?.cookie) return null;
  const { WebSocket: WsWebSocket } = await import('ws');
  const cookie = ep.cookie;
  return { url: ep.mux, connect: (url) => new WsWebSocket(url, { headers: { cookie } }) };
}

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
      logDebug('connect called');
      const listeners: Emit[] = [];
      const openSessions = new Map<string, string>();   // paseoSessionId → dshSessionId
      const activeTurns = new Map<string, AbortController>();
      const activeTurnIds = new Map<string, string>();   // paseoSessionId → 正在跑的 turnId
      /** 上一轮的收尾 Promise：interrupt 后立刻 prompt 时先等它，避免误判 busy。 */
      const turnSettled = new Map<string, Promise<unknown>>();
      const sessionModels = new Map<string, ModelRef>(); // paseoSessionId → DSH 当前模型
      /** paseoSessionId → DSH 命令名集合。Paseo 的 bridge 有时不会把 "/xxx" 转成命令输入
       *  （0.15.3 实测仍按普通文本发过来），所以服务端按这份名单兜底识别。 */
      const commandNames = new Map<string, Set<string>>();
      // 每个 provider 连接独立：观察者 / 外部正在跑的回合（steer 复用 turnId）
      const observerState: ObserverState = { observers: new Map(), observedTurns: new Map() };
      const emit: Emit = (e) => listeners.forEach((l) => l(e));

      const dshCommandNames = async (sid: string, dshId: string): Promise<Set<string>> => {
        const cached = commandNames.get(sid);
        if (cached) return cached;
        const cmds = await listCommands(dshId).catch(() => [] as any[]);
        const names = new Set<string>(cmds.map((c: any) => String(c.name)));
        if (names.size) commandNames.set(sid, names);
        return names;
      };

      /** 执行一条 DSH 斜杠命令（两条入口共用：Paseo 的 command 输入 / 文本兜底识别）。 */
      const runCommand = async (sid: string, dshId: string, line: string, clientMessageId: string) => {
        const name = line.replace(/^\//, '').split(/\s+/)[0];
        logInfo('command', { session: sid, dsh: dshId, name, argsChars: Math.max(0, line.length - name.length - 1) });
        // 镜像会同时收到 command/run + command/done：先暂停，回执由下面统一发，避免重复两条
        const observerEntry = observerState.observers.get(sid);
        observerEntry?.setPaused(true);
        try {
          const r = await executeCommand(dshId, line);
          const text = r.result?.text || '';
          if (text) {
            emit({
              type: 'timeline.item',
              sessionId: sid,
              item: { type: 'assistant_message', id: `cmd-${r.commandId || Date.now()}`, text },
            });
          }
          emitUsage(emit, sid, await sessionContextUsage(dshId).catch(() => null));
          emit({
            type: 'session.prompt_result',
            sessionId: sid,
            clientMessageId,
            result: { type: 'completed' },
          });
        } catch (e) {
          const msg = errorMessage(e);
          logWarn('command failed', { session: sid, name, error: msg });
          emit({
            type: 'session.notice',
            sessionId: sid,
            notice: {
              id: `cmd-err-${Date.now()}`,
              severity: 'warning',
              title: 'DSH',
              description: `命令 /${name} 失败：${msg}`,
            },
          });
          emit({
            type: 'session.prompt_result',
            sessionId: sid,
            clientMessageId,
            result: { type: 'failed', error: { message: `命令 /${name} 失败：${msg}`, code: 'dsh/command' } },
          });
        } finally {
          observerEntry?.setPaused(false);
        }
      };

      return {
        // ProviderConnection 契约要求（漏了会被判 invalid message）
        version: 1,
        capabilities: CAPABILITIES,

        /** 只做接收与分发；结果全部以事件返回。 */
        async send(input: any) {
          const startedAt = Date.now();
          // 不打印 prompt 正文（隐私）；只记形状
          const logInput = input?.type === 'session.prompt'
            ? {
                type: 'session.prompt',
                sessionId: input.sessionId,
                clientMessageId: input.prompt?.clientMessageId,
                blocks: Array.isArray(input.prompt?.input?.content) ? input.prompt.input.content.length : undefined,
                delivery: input.prompt?.delivery,
              }
            : input?.type === 'session.open'
              ? {
                  type: 'session.open',
                  sessionId: input.sessionId,
                  cwd: input.config?.cwd,
                  history: input.history,
                  persistence: Boolean(input.persistence),
                }
              : input;
          logDebug('input', { type: logInput?.type, session: logInput?.sessionId, delivery: logInput?.delivery, blocks: logInput?.blocks, history: logInput?.history });
          try {
            switch (input?.type) {
              case 'catalog': {
                const cat = await loadCatalog();
                const { models, defaultModel, defaultThinkingOption } = catalogDefaults(cat);
                if (!models.length) throw new Error('DSH 模型目录为空');
                emit({
                  type: 'catalog',
                  requestId: input.requestId,
                  catalog: {
                    models,
                    modes: [{ id: 'default', label: 'default' }],
                    defaultModel,
                    defaultMode: 'default',
                    ...(defaultThinkingOption ? { defaultThinkingOption } : {}),
                  },
                });
                break;
              }

              case 'sessions': {
                const items = await listSessions();
                await fillMissingTitles(items, input.limit ?? 50);
                logInfo('sessions fetched', { count: items.length });
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
                  logInfo('created dsh session', { dsh: dshId });
                }
                openSessions.set(sid, dshId);

                // 标题：已有会话用 DSH 的标题；新会话把 Paseo 的 config.title 回写到 DSH。
                const info = await sessionInfo(dshId, { withRunning: true });
                logInfo('session.open', { session: sid, dsh: dshId, history: input.history, running: info.running });
                const desiredTitle = str(input.config?.title);
                let dshTitle = info.title;
                if (desiredTitle && (!dshTitle || !input.persistence)) {
                  try {
                    await renameSession(dshId, desiredTitle);
                    dshTitle = desiredTitle;
                  } catch (e) {
                    logWarn('rename failed', { dsh: dshId, error: errorMessage(e) });
                  }
                }
                const title = desiredTitle || dshTitle;

                emit({
                  type: 'session.opened',
                  requestId: input.requestId,
                  sessionId: sid,
                  capabilities: CAPABILITIES,
                  restoration: 'core',
                  persistence: { version: 1, data: { sessionId: dshId } },
                  cwd: String(input.config?.cwd ?? defaultCwd()),
                  ...(title ? { title } : {}),
                });

                // 把 DSH 侧的当前模型同步给 Paseo（已有会话读 projections.modelSelection，
                // 新会话回落到目录默认值），并应用 Paseo 在 open 时指定的模型/思考档位。
                let model = await resolveSessionModel(dshId).catch(() => null);
                const requestedModel = str(input.config?.model);
                const requestedThinking = str(input.config?.thinkingOption);
                const target = requestedModel ? parseModelId(requestedModel) : null;
                if (requestedModel && !target) {
                  emit({
                    type: 'session.notice',
                    sessionId: sid,
                    notice: {
                      id: `open-model-${Date.now()}`,
                      severity: 'info',
                      title: 'DSH',
                      description: `未知模型 id：${requestedModel}，使用 DSH 当前模型`,
                    },
                  });
                }
                // 已有会话（persistence）以 DSH 为准，open 时不应用 Paseo 的配置：
                // 导入会话时 Paseo 会填 catalog 默认模型，之前会把它写回 DSH，改掉会话原模型。
                // 用户显式切换走 session.configure；新会话仍应用 open 时的 model/thinking。
                const existingSession = Boolean(input.persistence?.data?.sessionId);
                if (!existingSession && (target || (requestedThinking && model))) {
                  const provider = target?.provider ?? model!.provider;
                  const modelId = target?.model ?? model!.model;
                  const effort = requestedThinking || model?.reasoningEffort;
                  const same = model
                    && model.provider === provider
                    && model.model === modelId
                    && (!requestedThinking || model.reasoningEffort === requestedThinking);
                  if (!same) {
                    try {
                      const r = await selectModel(dshId, provider, modelId, effort);
                      model = {
                        provider: r.selected.provider,
                        model: r.selected.model,
                        ...(r.selected.reasoningEffort ? { reasoningEffort: r.selected.reasoningEffort } : {}),
                      };
                    } catch (e) {
                      // 目录漂移（Paseo 手里还有 DSH 已下线的 provider/model）：清缓存，
                      // 下面的 session.config 会用刷新后的目录，UI 不再挂着坏模型
                      catalogCache = null;
                      logWarn('selectModel failed (open)', { dsh: dshId, model: encodeModelId(provider, modelId), error: errorMessage(e) });
                      emit({
                        type: 'session.notice',
                        sessionId: sid,
                        notice: {
                          id: `open-model-err-${Date.now()}`,
                          severity: 'warning',
                          title: 'DSH',
                          description: `无法应用模型/思考档位：${errorMessage(e)}（已刷新可用模型）`,
                        },
                      });
                    }
                  }
                }
                if (model) sessionModels.set(sid, model);
                const cat = model ? await loadCatalog().catch(() => null) : null;
                if (cat) {
                  emit({ type: 'session.config', sessionId: sid, config: toProviderConfig(cat, model) });
                }
                if (info.usage) emitUsage(emit, sid, info.usage);
                const emitGoal = () => {
                  if (!info.goal) return false;
                  const item = goalTodoItem(info.goal.goal, info.goal.roundsStarted);
                  if (!item) return false;
                  emit({ type: 'timeline.item', sessionId: sid, item });
                  return true;
                };
                const emitTodos = () => {
                  if (!info.todos) return false;
                  emit({ type: 'timeline.item', sessionId: sid, item: { type: 'todo', id: 'dsh-todo', items: info.todos } });
                  return true;
                };
                if (input.history !== 'replay') {
                  emitGoal();
                  emitTodos();
                }
                // steer 模式下不再弹「会话正在运行」的常驻 notice（会过期）；
                // 运行中的外部回合由 replay + 实时镜像来展示。fail 模式才需要提前警告。
                if (info.running && (process.env.DSH_RUNNING_MODE || 'steer').toLowerCase() === 'fail') {
                  emit({
                    type: 'session.notice',
                    sessionId: sid,
                    notice: {
                      id: `running-${Date.now()}`,
                      severity: 'warning',
                      title: 'DSH',
                      description: '该 DSH 会话正在运行（可能来自 DSH 桌面版或其他客户端）；发送消息会被拒绝，直到当前轮结束',
                    },
                  });
                }

                let openTurn: number | null = null;
                if (input.history === 'replay' && input.persistence?.data?.sessionId) {
                  const snap = await fetchSessionSnapshot(dshId);
                  let sawTodo = false;
                  if (snap.hasMore) {
                    // DSH 的快照窗口几乎总是 hasMore；这是内部细节，只记日志不弹 notice
                    logInfo('replay snapshot truncated', { dsh: dshId, cursor: snap.cursor });
                  }
                  const events = snap.events;
                  logInfo('replay events', { dsh: dshId, count: events.length });
                  let n = 0;
                  const pending = new Map<string, any>();
                  for (const ev of events) {
                    if (ev.type === 'todo/write') sawTodo = true;
                    if (ev.type === 'turn/start') openTurn = Number(ev.data?.turn) || 0;
                    else if (ev.type === 'turn/end') openTurn = null;
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
                  logInfo('timeline items emitted', { dsh: dshId, count: n });
                  // goal 是当前状态而不是事件流：历史里 create/revise/complete 每个 revision
                  // 都发卡会让刷新后的时间线堆出多张目标卡，只保留 projections 的一张。
                  emitGoal();
                  // todo 若历史里没有（或被截断），用 projections 补一张
                  if (!sawTodo) emitTodos();
                }

                // DSH 的斜杠命令（/compact、/goal、/plan…）。Paseo 只认声明过的命令；
                // 不声明时 /compact 会被当普通文本发出去，用户看到的就是"没压缩"。
                const cmds = await listCommands(dshId).catch(() => [] as any[]);
                if (cmds.length) {
                  emit({
                    type: 'session.commands',
                    sessionId: sid,
                    commands: cmds.map((c) => ({
                      name: c.name,
                      description: c.description || c.name,
                      ...(c.input?.hint ? { argumentHint: c.input.hint } : {}),
                    })),
                  });
                  commandNames.set(sid, new Set(cmds.map((c) => String(c.name))));
                  logInfo('session.commands', { session: sid, count: cmds.length });
                }

                emit({ type: 'session.ready', sessionId: sid, requestId: input.requestId });
                // 导入时若回合仍在进行，先宣告 turn started，让 Paseo 显示 running；
                // 之后由观察者把同一个 turn 关掉。
                if (openTurn != null) {
                  emit({ type: 'session.turn', sessionId: sid, turnId: `dsh-ext-${openTurn}`, state: 'started' });
                }
                // 只读镜像：DSH 桌面版/其他客户端发起的回合实时进入 Paseo
                void startObserver(observerState, sid, dshId, emit,
                  openTurn != null ? { n: openTurn, id: `dsh-ext-${openTurn}` } : undefined);
                logDebug('emitted session.ready', { session: sid });
                break;
              }

              case 'session.prompt': {
                const p = input.prompt || {};
                const dshId = openSessions.get(input.sessionId) || input.sessionId;
                const clientMessageId = p.clientMessageId ?? '';

                // 斜杠命令输入：走 DSH 的 commands/execute
                if (p.input?.type === 'command') {
                  const name = String(p.input.name || '').replace(/^\//, '');
                  const args = String(p.input.arguments ?? '');
                  await runCommand(input.sessionId, dshId, `/${name}${args ? ` ${args}` : ''}`, clientMessageId);
                  break;
                }

                const { blocks, text } = extractContent(p);
                logInfo('prompt', { session: input.sessionId, dsh: dshId, chars: text.length, blocks: blocks.length, delivery: p.delivery });
                if (!blocks.length) {
                  emit({
                    type: 'session.prompt_result',
                    sessionId: input.sessionId,
                    clientMessageId,
                    result: { type: 'failed' },
                  });
                  break;
                }
                // 图片能力预检：已知该模型不收图片就直接给可读错误，别让整轮打到 DSH 才失败
                if (blocks.some((b) => b.type === 'image')) {
                  const current = sessionModels.get(input.sessionId)
                    ?? (await resolveSessionModel(dshId).catch(() => null));
                  const modelKey = current ? encodeModelId(current.provider, current.model) : '';
                  if (modelKey && imageUnsupported.has(modelKey)) {
                    logWarn('prompt rejected: model has no image support', { session: input.sessionId, model: modelKey });
                    emit({
                      type: 'session.prompt_result',
                      sessionId: input.sessionId,
                      clientMessageId,
                      result: {
                        type: 'failed',
                        error: {
                          message: `当前模型 ${current!.model} 不支持图片输入：请换用支持图片的模型，或去掉图片后重发`,
                          code: 'dsh/no-image-support',
                        },
                      },
                    });
                    break;
                  }
                }
                // steer：把新消息插进正在运行的轮次，立即回 {type:'steer', turnId}。
                // Paseo 只有在拿到的 turnId 与它在跑的 turn 一致时才认为插入成功。
                if (p.delivery === 'steer') {
                  if (!activeTurns.has(input.sessionId)) {
                    emit({
                      type: 'session.prompt_result',
                      sessionId: input.sessionId,
                      clientMessageId,
                      result: { type: 'failed', error: { message: '没有正在运行的轮次可插入（steer）', code: 'dsh/steer' } },
                    });
                    break;
                  }
                  try {
                    await promptSession(dshId, blocks, 'steer');
                    emit({
                      type: 'session.prompt_result',
                      sessionId: input.sessionId,
                      clientMessageId,
                      result: { type: 'steer', turnId: activeTurnIds.get(input.sessionId) || 'dsh-turn-?' },
                    });
                  } catch (e) {
                    emit({
                      type: 'session.prompt_result',
                      sessionId: input.sessionId,
                      clientMessageId,
                      result: { type: 'failed', error: { message: errorMessage(e), code: 'dsh/steer' } },
                    });
                  }
                  break;
                }
                // 兜底：Paseo 的 bridge 没把 "/compact" 转成 command 时会走到这里。
                // 只对 DSH 命令目录里存在的名字生效，避免误伤以 "/" 开头的正常文本。
                if (p.delivery !== 'steer') {
                  const slash = /^\/([a-z][a-z0-9-]*)(?:\s+[\s\S]*)?$/.exec(text);
                  if (slash) {
                    const names = await dshCommandNames(input.sessionId, dshId);
                    if (names.has(slash[1])) {
                      await runCommand(input.sessionId, dshId, text, clientMessageId);
                      break;
                    }
                  }
                }
                if (activeTurns.has(input.sessionId)) {
                  // 中断后立刻发消息：上一轮的 abort → 收尾是异步的，finally 还没跑完。
                  // 直接判 busy 会把用户的正常操作打成失败（2026-11-07 两例），先等收尾。
                  const settling = turnSettled.get(input.sessionId);
                  if (settling) {
                    await Promise.race([
                      settling.catch(() => {}),
                      new Promise((resolve) => setTimeout(resolve, 3000)),
                    ]);
                  }
                }
                if (activeTurns.has(input.sessionId)) {
                  logWarn('prompt rejected: turn busy', { session: input.sessionId, dsh: dshId });
                  emit({
                    type: 'session.prompt_result',
                    sessionId: input.sessionId,
                    clientMessageId,
                    result: { type: 'failed', error: { message: 'session busy: a turn is already running', code: 'dsh/busy' } },
                  });
                  break;
                }
                // DSH 里可能已经有别的客户端在跑（例如桌面版/另一个 Paseo 连接）。
                // 默认 steer 插进当前轮次；DSH_RUNNING_MODE=fail 可改回快速失败。
                const info = await sessionInfo(dshId, { withRunning: true }).catch(() => null);
                const externalRunning = info?.running === true;
                const runningMode = (process.env.DSH_RUNNING_MODE || 'steer').toLowerCase();
                if (externalRunning && runningMode === 'fail') {
                  emit({
                    type: 'session.prompt_result',
                    sessionId: input.sessionId,
                    clientMessageId,
                    result: {
                      type: 'failed',
                      error: {
                        message: 'DSH 会话正在运行（可能来自 DSH 桌面版或其他客户端）；请等当前轮结束或先在 DSH 中取消',
                        code: 'dsh/busy',
                      },
                    },
                  });
                  break;
                }
                const steerExternal = externalRunning;
                // Paseo 的 plugin bridge 拿到 prompt_result(turn|steer) 才算 run 启动，
                // 否则 60s 后按「run did not start」中止。turnId 由我们生成并贯穿整轮，
                // 不依赖 DSH turn/start 的到达时机。插话时复用观察者已知的 turnId。
                const observedTurn = observerState.observedTurns.get(input.sessionId);
                const turnId = steerExternal
                  ? (observedTurn?.id ?? `dsh-steer-${Date.now()}`)
                  : `dsh-turn-${Date.now()}`;
                let turnStartReported = false;
                const beginTurn = (kind: 'turn' | 'steer') => {
                  if (turnStartReported) return;
                  turnStartReported = true;
                  emit({
                    type: 'session.prompt_result',
                    sessionId: input.sessionId,
                    clientMessageId,
                    result: { type: kind, turnId },
                  });
                  emit({ type: 'session.turn', sessionId: input.sessionId, turnId, state: 'started' });
                  activeTurnIds.set(input.sessionId, turnId);
                };
                if (steerExternal) {
                  beginTurn('steer');
                  emit({
                    type: 'session.notice',
                    sessionId: input.sessionId,
                    notice: {
                      id: `steer-${Date.now()}`,
                      severity: 'info',
                      title: 'DSH',
                      description: 'DSH 会话正在运行，已将消息插入当前轮次（steer）',
                    },
                  });
                }
                // 持久 follow：snapshot 定基线 → 发 prompt → 消费 event/assistant-stream
                // → turn/end 收工 → 最后才发 prompt_result。
                // 不 await：让 interrupt/close 能在本轮运行期间被处理。
                // 自有回合要独占输出：暂停只读镜像，但不关它的 WS
                // （2026-11-10：以前是 stop/start，每轮重建一次连接，DSH 重启期尤其脆）
                observerState.observers.get(input.sessionId)?.setPaused(true);
                const ctl = new AbortController();
                activeTurns.set(input.sessionId, ctl);
                let turnClosed = false;
                const turnPromise = runTurn(input.sessionId, dshId, text, emit, {
                  signal: ctl.signal,
                  content: blocks,
                  mode: steerExternal ? 'steer' : 'queue',
                  // 外部轮次可能很长：放宽预算、也不用 idle 兜底提前收工
                  ...(steerExternal
                    ? {
                        budgetMs: Number(process.env.DSH_STEER_BUDGET_MS) || 6 * 60 * 60_000,
                        replyIdleTicks: 1_000_000,
                      }
                    : {}),
                  turnIdOverride: turnId,
                  suppressTurnStart: true,
                  // 纯图片消息没有可匹配的用户文本，跳过 echo 等待
                  startPhase: text ? 'waitEcho' : 'running',
                  // prompt 已被 DSH 接受（或成功 steer）→ 立刻回 run start
                  onStarted: () => { if (!steerExternal) beginTurn('turn'); },
                  onTurn: (id, state) => {
                    if (state === 'started') {
                      activeTurnIds.set(input.sessionId, id);
                    } else {
                      turnClosed = true;
                      if (activeTurnIds.get(input.sessionId) === id) activeTurnIds.delete(input.sessionId);
                    }
                  },
                })
                  .then(async ({ reason, interrupted }) => {
                    if (turnStartReported && !turnClosed) {
                      turnClosed = true;
                      emit({
                        type: 'session.turn',
                        sessionId: input.sessionId,
                        turnId,
                        state: reason === 'canceled' ? 'canceled'
                          : reason === 'completed' ? 'completed' : 'failed',
                      });
                    }
                    emit({
                      type: 'session.prompt_result',
                      sessionId: input.sessionId,
                      clientMessageId,
                      result: reason === 'completed'
                        ? { type: 'completed' }
                        : {
                            type: 'failed',
                            error: {
                              message: interrupted
                                ? `turn ${reason}（DSH 连接中断 / 桌面端重启）`
                                : `turn ${reason}`,
                              code: 'dsh/turn',
                            },
                          },
                    });
                  })
                  .catch((e) => {
                    if (turnStartReported && !turnClosed) {
                      turnClosed = true;
                      emit({
                        type: 'session.turn',
                        sessionId: input.sessionId,
                        turnId,
                        state: 'failed',
                        error: { message: errorMessage(e) },
                      });
                    }
                    const msg = errorMessage(e);
                    if (ATTACHMENT_REJECTED.test(msg)) {
                      const current = sessionModels.get(input.sessionId);
                      if (current) {
                        const key = encodeModelId(current.provider, current.model);
                        imageUnsupported.add(key);
                        logWarn('learned: model has no image support', { session: input.sessionId, model: key });
                      }
                      emit({
                        type: 'session.prompt_result',
                        sessionId: input.sessionId,
                        clientMessageId,
                        result: {
                          type: 'failed',
                          error: {
                            message: `模型${current ? ` ${current.model}` : ''} 不接受本次附件（图片）：请换用支持图片的模型，或去掉图片后重发`,
                            code: 'dsh/attachment',
                          },
                        },
                      });
                    } else {
                      emit({
                        type: 'session.prompt_result',
                        sessionId: input.sessionId,
                        clientMessageId,
                        result: { type: 'failed', error: { message: msg, code: 'dsh/error' } },
                      });
                    }
                  })
                  .finally(() => {
                    if (activeTurns.get(input.sessionId) === ctl) activeTurns.delete(input.sessionId);
                    activeTurnIds.delete(input.sessionId);
                    observerState.observedTurns.delete(input.sessionId);
                    if (turnSettled.get(input.sessionId) === turnPromise) turnSettled.delete(input.sessionId);
                    if (openSessions.get(input.sessionId) === dshId) {
                      const obs = observerState.observers.get(input.sessionId);
                      if (obs) obs.setPaused(false);
                      else void startObserver(observerState, input.sessionId, dshId, emit);
                    }
                  });
                turnSettled.set(input.sessionId, turnPromise);
                break;
              }

              case 'session.interrupt': {
                const dshId = openSessions.get(input.sessionId) || input.sessionId;
                activeTurns.get(input.sessionId)?.abort();
                await interruptSession(dshId);
                break;
              }

              case 'session.configure': {
                // Paseo 的模型/思考档位变更 → DSH session/selectModel。
                const sid = input.sessionId;
                const dshId = openSessions.get(sid) || sid;
                const changes = input.changes || {};
                const cat = await loadCatalog();
                let next = sessionModels.get(sid) ?? (await resolveSessionModel(dshId).catch(() => null));
                let applied = false;
                const note = (description: string, severity: 'info' | 'warning' = 'info') => emit({
                  type: 'session.notice',
                  sessionId: sid,
                  notice: { id: `cfg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, severity, title: 'DSH', description },
                });

                if (changes.model !== undefined) {
                  if (changes.model === null) {
                    note('DSH 会话不能清空模型，已忽略');
                  } else {
                    const parsed = parseModelId(changes.model);
                    if (parsed) {
                      next = {
                        provider: parsed.provider,
                        model: parsed.model,
                        ...(next?.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}),
                      };
                      applied = true;
                    } else if (!next || changes.model !== encodeModelId(next.provider, next.model)) {
                      // 旧版本持久化的模型 id（如 dsh-default）不再存在，保留 DSH 侧当前值
                      note(`未知模型 id：${changes.model}，保留当前模型`);
                    }
                  }
                }
                if (changes.thinkingOption !== undefined) {
                  if (!next) throw new Error('当前会话还没有已知模型，无法设置 reasoning effort');
                  next = changes.thinkingOption
                    ? { ...next, reasoningEffort: String(changes.thinkingOption) }
                    : { provider: next.provider, model: next.model };
                  applied = true;
                }
                if (changes.mode !== undefined && changes.mode !== null && changes.mode !== 'default') {
                  note(`DSH 不支持模式切换，已忽略：${changes.mode}`);
                }
                if (changes.settings && Object.keys(changes.settings).length) {
                  note(`DSH 不支持这些设置，已忽略：${Object.keys(changes.settings).join(', ')}`);
                }
                if (!next) throw new Error('无法确定 DSH 会话模型');

                if (applied) {
                  try {
                    const r = await selectModel(dshId, next.provider, next.model, next.reasoningEffort);
                    next = {
                      provider: r.selected.provider,
                      model: r.selected.model,
                      ...(r.selected.reasoningEffort ? { reasoningEffort: r.selected.reasoningEffort } : {}),
                    };
                  } catch (e) {
                    // 常见于目录漂移：Paseo 的模型列表里还有 DSH 已下架的 provider/model。
                    // 以前这里会把整条 configure 打成 request.failed，且 UI 继续提供坏模型。
                    const requested = encodeModelId(next.provider, next.model);
                    logWarn('selectModel failed', { session: sid, dsh: dshId, requested, error: errorMessage(e) });
                    note(`切换模型失败：${errorMessage(e)}（已刷新可用模型列表）`, 'warning');
                    sessionModels.delete(sid);
                    const fallback = await resolveSessionModel(dshId).catch(() => null);
                    next = fallback;
                    catalogCache = null;
                    const fresh = await loadCatalog(0).catch(() => cat);
                    emit({ type: 'session.config', sessionId: sid, config: toProviderConfig(fresh, next) });
                    if (next) sessionModels.set(sid, next);
                    break;
                  }
                }
                sessionModels.set(sid, next);
                emit({ type: 'session.config', sessionId: sid, config: toProviderConfig(cat, next) });
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
                stopObserver(observerState, input.sessionId);
                observerState.observedTurns.delete(input.sessionId);
                openSessions.delete(input.sessionId);
                sessionModels.delete(input.sessionId);
                lastUsageBySession.delete(input.sessionId);
                commandNames.delete(input.sessionId);
                emit({ type: 'session.closed', sessionId: input.sessionId });
                logInfo('session.closed', { session: input.sessionId });
                break;
              }

              case 'session.permission':
                logDebug('permission response ignored', { permission: input.permissionId });
                return;

              default: {
                const message = `unsupported input: ${input?.type}`;
                logWarn('unsupported input', { type: input?.type });
                if (input?.requestId) {
                  emit({ type: 'request.failed', requestId: input.requestId, error: { message, code: 'dsh/unsupported' } });
                  return; // 不再补 request.completed
                }
                break;
              }
            }
            if (input?.requestId) {
              emit({ type: 'request.completed', requestId: input.requestId });
              logDebug('request.completed', { type: input.type, ms: Date.now() - startedAt });
            }
          } catch (e) {
            const message = errorMessage(e);
            logError('input failed', { type: input?.type, error: message });
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
          for (const id of [...observerState.observers.keys()]) stopObserver(observerState, id);
          observerState.observedTurns.clear();
        },
      };
    },
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** 已有会话读 projections.modelSelection；新会话/读不到时回落到目录默认值。 */
async function resolveSessionModel(dshId: string): Promise<ModelRef | null> {
  try {
    const items = await listSessions();
    const ref = sessionModelRef(items.find((s) => s.sessionId === dshId));
    if (ref) return ref;
  } catch {}
  const cat = await loadCatalog().catch(() => null);
  return cat?.default?.provider && cat.default.model
    ? { provider: cat.default.provider, model: cat.default.model }
    : null;
}

/** 从 session/list 的 projections.contextPressure 读上下文窗口与已用 token。 */
function contextUsageFromValues(values: any) {
  const p = values?.contextPressure;
  const used = typeof p?.pressureTokens === 'number' && Number.isFinite(p.pressureTokens) ? p.pressureTokens : undefined;
  const max = typeof p?.contextWindow === 'number' && Number.isFinite(p.contextWindow) && p.contextWindow > 0
    ? p.contextWindow
    : undefined;
  if (used == null && max == null) return null;
  return {
    ...(used != null ? { contextWindowUsedTokens: used } : {}),
    ...(max != null ? { contextWindowMaxTokens: max } : {}),
  };
}

function contextUsageOf(item: any) {
  return contextUsageFromValues(item?.projections?.values);
}

/** 单会话取占用：优先 `session/projections`（只查一个会话），失败再退回 `session/list`。 */
async function sessionContextUsage(dshId: string) {
  try {
    const values = await sessionProjections(dshId);
    const usage = contextUsageFromValues(values);
    if (usage) return usage;
  } catch {}
  try {
    const items = await listSessions();
    return contextUsageOf(items.find((s) => s.sessionId === dshId));
  } catch {
    return null;
  }
}

/** goal projection 形状：{ goal:{id,revision,objective,phase,maxGoalRounds}, roundsStarted, ... } */
function goalOfItem(item: any) {
  const g = item?.projections?.values?.goal;
  if (!g || typeof g !== 'object') return null;
  if (g.goal && typeof g.goal === 'object') return { goal: g.goal, roundsStarted: g.roundsStarted };
  return { goal: g };
}

function todosOfItem(item: any) {
  const t = item?.projections?.values?.todos;
  if (!Array.isArray(t)) return null;
  const items = t
    .map((x: any, i: number) => ({
      id: String(i),
      text: String(x?.content ?? x?.text ?? ''),
      completed: x?.status === 'completed',
      ...(x?.status ? { status: x.status } : {}),
    }))
    .filter((x: any) => x.text);
  return items.length ? items : null;
}

/** DSH goal → Paseo todo 项（Paseo 没有独立的 goal 卡片，todo 是唯一持久的列表位）。 */
function goalTodoItem(goal: any, roundsStarted?: number) {
  const objective = String(goal?.objective ?? '').replace(/\s+/g, ' ').trim();
  if (!objective) return null;
  const short = objective.length > 300 ? `${objective.slice(0, 300)}…` : objective;
  const max = Number(goal?.maxGoalRounds) || 0;
  const rounds = max && roundsStarted != null ? `（${roundsStarted}/${max} 轮）` : '';
  const phase = String(goal?.phase ?? 'active');
  // 真机 phase 取值是 active / complete（不是 completed），两种都算完成
  const completed = phase === 'complete' || phase === 'completed' || phase === 'done';
  const status = completed ? 'completed' : phase === 'paused' ? 'pending' : 'in_progress';
  return {
    type: 'todo' as const,
    id: 'dsh-goal',
    items: [{ id: String(goal?.id ?? 'goal'), text: `目标：${short}${rounds}`, completed, status }],
  };
}

/**
 * 会话状态。默认走单会话 `session/projections`（以前每次都 `session/list` 拉全部会话，
 * 会话一多就明显变慢）；只有确实需要 `running`（没有镜像连接可参考时）才额外查一次列表。
 */
async function sessionInfo(dshId: string, opts: { withRunning?: boolean } = {}) {
  try {
    if (opts.withRunning) {
      // running 只存在于 session/list 的条目上：需要它时就直接查列表（保持单次调用）
      const items = await listSessions().catch(() => [] as any[]);
      const item = items.find((s) => s.sessionId === dshId);
      const values = item?.projections?.values;
      const title = values?.title;
      return {
        title: typeof title === 'string' && title.trim() ? title : undefined,
        running: item?.running === true,
        usage: contextUsageFromValues(values),
        goal: goalOfItem(item),
        todos: todosOfItem(item),
      };
    }
    const values = await sessionProjections(dshId).catch(() => null);
    const title = values?.title;
    return {
      title: typeof title === 'string' && title.trim() ? title : undefined,
      running: false,
      usage: contextUsageFromValues(values),
      goal: goalOfItem({ projections: { values } }),
      todos: todosOfItem({ projections: { values } }),
    };
  } catch {
    return { title: undefined, running: false, usage: null, goal: null, todos: null };
  }
}

/** DSH usage chunk → Paseo ProviderUsage。
 *  实测（2026-11-03）真实字段是 camelCase：inputTokens / cacheReadTokens / outputTokens。
 *  早先只认 snake_case，真机上 usage 会全部丢成 undefined；两套都收。 */
export function usageFromChunk(c: any) {
  const u = c?.usage || c?.usageMetadata || c || {};
  const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const cand = num(u.candidatesTokenCount);
  const thought = num(u.thoughtsTokenCount);
  const geminiOutput = cand == null && thought == null ? undefined : (cand || 0) + (thought || 0);
  const usage = {
    inputTokens: num(u.inputTokens) ?? num(u.input_tokens) ?? num(u.input) ?? num(u.promptTokenCount),
    cachedInputTokens:
      num(u.cacheReadTokens) ?? num(u.cache_read_input_tokens) ?? num(u.cachedContentTokenCount) ?? num(u.cacheRead),
    outputTokens: num(u.outputTokens) ?? num(u.output_tokens) ?? num(u.output) ?? geminiOutput,
  };
  return Object.values(usage).some((v) => v != null) ? usage : null;
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
  } else if (ev.type === 'todo/write') {
    const items = (Array.isArray(d.todos) ? d.todos : [])
      .map((t: any, i: number) => ({
        id: String(i),
        text: String(t?.content ?? t?.text ?? ''),
        completed: t?.status === 'completed',
        ...(t?.status ? { status: t.status } : {}),
      }))
      .filter((t: any) => t.text);
    // 固定 id：Paseo 按 id 合并，连续 todo/write 只更新同一条
    out.push({ type: 'todo', id: 'dsh-todo', items });
  } else if (ev.type === 'tool/call') {
    const callId = String(d.callId || ev.seq);
    pending.set(callId, { d, seq: ev.seq, time: ev.time });
    out.push({ type: 'tool_call', id: `t-${ev.seq}`, callId,
      ...buildToolCall(d, '', 'running') });
  } else if (ev.type === 'tool/result') {
    const callId = String(d.toolCallId || d?.message?.source?.callId || '');
    const p = pending.get(callId);
    if (p) {
      pending.delete(callId);
      out.push({ type: 'tool_call', id: `t-${p.seq}`, callId,
        ...buildToolCall(p.d, texts(d?.message?.content, ['text']), 'completed') });
    }
  }
  return out;
}

/** 按 DSH 工具名映射到 Paseo 的 detail 联合类型。 */
function buildToolCall(d: any, output: string, status: 'running' | 'completed' | 'failed' = 'completed') {
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
  return {
    name,
    detail,
    status,
    error: status === 'failed' ? { message: output || 'tool failed' } : null,
  };
}

/** 未拿到 result 的工具：结算成 failed，避免界面永远 running。 */
function settleToolFailure(callId: string, p: any, paseoId: string, emit: Emit, message: string) {
  const built = buildToolCall(p.d, message, 'failed');
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

type ObserverState = {
  observers: Map<string, ObserverEntry>;
  /** 外部（DSH 桌面版等）正在进行的回合，供 steer 复用同一个 turnId。 */
  observedTurns: Map<string, { n: number; id: string }>;
};

/** 只读镜像的连接句柄。`setPaused(true)` 只丢输出、不关连接：
 *  Paseo 自有回合期间由 runTurn 独占输出，但 WS 连接保持不变（2026-11-10）。 */
type ObserverEntry = { stop: () => void; setPaused: (paused: boolean) => void };

function stopObserver(state: ObserverState, paseoId: string) {
  const o = state.observers.get(paseoId);
  if (!o) return;
  state.observers.delete(paseoId);
  logDebug('observer stop', { session: paseoId });
  try { o.stop(); } catch {}
}

/** 只读实时镜像：会话打开后跟随 DSH 事件，把外部回合写进 Paseo 时间线。
 *  不发送 prompt_result；自有回合（runTurn）开始前会停掉观察者，结束后再恢复。 */
function startObserver(
  state: ObserverState,
  paseoId: string,
  dshId: string,
  emit: Emit,
  initialTurn?: { n: number; id: string },
) {
  if (state.observers.has(paseoId)) return;
  let closed = false;
  let paused = false;
  let follow: ReturnType<typeof followSession> | null = null;
  const entry: ObserverEntry = {
    stop() {
      if (closed) return;
      closed = true;
      try { follow?.close(); } catch {}
    },
    setPaused(next: boolean) {
      if (closed || paused === next) return;
      paused = next;
      logDebug('observer pause', { session: paseoId, dsh: dshId, paused: next });
    },
  };
  // 先同步登记，避免「open 后立刻 prompt」时观察者还没注册、stop 落空
  state.observers.set(paseoId, entry);
  if (initialTurn) state.observedTurns.set(paseoId, { ...initialTurn });
  else state.observedTurns.delete(paseoId);
  logDebug('observer start', { session: paseoId, dsh: dshId });

  void (async () => {
    const ep = await getDshEndpoint().catch(() => null);
    if (closed) return;
    if (!ep?.cookie && ep?.source === 'discovered-no-cookie') {
      logWarn('observer skipped: DSH auth missing', { session: paseoId, dsh: dshId });
      if (state.observers.get(paseoId) === entry) state.observers.delete(paseoId);
      return;
    }
    let connect: ((url: string) => any) | undefined;
    if (ep?.cookie) {
      const { WebSocket: WsWebSocket } = await import('ws');
      const cookie = ep.cookie;
      connect = (url) => new WsWebSocket(url, { headers: { cookie } });
    }
    if (closed) return;
    try {
      follow = followSession(dshId, {
        assistantStream: true,
        readyTimeoutMs: 15_000,
        ...(ep ? { url: ep.mux } : {}),
        ...(connect ? { connect, headers: { cookie: ep?.cookie as string } } : {}),
        resolveEndpoint: endpointResolver,
      });
    } catch {
      if (state.observers.get(paseoId) === entry) state.observers.delete(paseoId);
      return;
    }
    if (closed) { try { follow.close(); } catch {} return; }

    const preview = createPreviewStreamer(paseoId, emit);
  // 外部回合（DSH 桌面版发起）结束后也刷新上下文占用，否则面板只在 Paseo 自己发消息时才动
  const refreshObserverUsage = async () => {
    emitUsage(emit, paseoId, await sessionContextUsage(dshId).catch(() => null));
  };
    const pending = new Map<string, any>();
    let active: { n: number; id: string } | null = initialTurn ?? null;
    try {
      await follow.ready;
      logDebug('observer ready', { session: paseoId, dsh: dshId });
    } catch {
      logWarn('observer not ready', { session: paseoId, dsh: dshId });
      if (state.observers.get(paseoId) === entry) state.observers.delete(paseoId);
      return;
    }
    for await (const msg of follow) {
      if (closed) break;
      if (msg.kind === 'assistant') {
        if (!paused) preview.frame(msg.frame);
        continue;
      }
      if (msg.kind !== 'event') continue; // snapshot/reset/gap 交给 follow 的静默重连
      const ev = msg.event as DshEvent;
      if (ev.type === 'user/message') {
        const kind = (ev.data as any)?.source?.kind;
        // 注入的 system-reminder/上下文不算用户消息（与 turn-state 同规则）
        if (kind !== 'user' && kind !== 'agent') continue;
      }
      if (ev.type === 'goal/change') continue; // goal 是状态卡，只在 open 时出
      if (ev.type === 'turn/start') {
        // 暂停期间仍要记录 turn，steer 才能复用同一个 id；只是不往时间线输出
        if (!paused) preview.flush();
        const n = Number((ev.data as any)?.turn);
        active = { n: Number.isFinite(n) ? n : 0, id: `dsh-ext-${Number.isFinite(n) ? n : ev.seq}` };
        state.observedTurns.set(paseoId, active);
        if (!paused) emit({ type: 'session.turn', sessionId: paseoId, turnId: active.id, state: 'started' });
        continue;
      }
      if (ev.type === 'turn/end') {
        if (!paused) preview.flush();
        const reason = (ev.data as any)?.reason?.kind;
        const turnState = reason === 'completed' ? 'completed'
          : (reason === 'canceled' || reason === 'aborted') ? 'canceled' : 'failed';
        if (active && !paused) emit({ type: 'session.turn', sessionId: paseoId, turnId: active.id, state: turnState });
        active = null;
        state.observedTurns.delete(paseoId);
        if (!paused) {
          flushPending(pending, paseoId, emit);
          void refreshObserverUsage();
        }
        continue;
      }
      if (ev.type === 'command/run') {
        // DSH 桌面版/其他客户端执行的斜杠命令：镜像成"用户发的命令"，
        // command/done 再补一条回执，否则 Paseo 侧完全看不到对方跑了 /compact
        const d: any = ev.data || {};
        if (!paused) {
          emit({
            type: 'timeline.item',
            sessionId: paseoId,
            item: {
              type: 'user_message',
              id: `cmd-run-${d.commandId || ev.seq}`,
              text: `/${d.name || '?'}${d.args ? ` ${d.args}` : ''}`,
            },
            timestamp: ev.time ? new Date(ev.time).toISOString() : undefined,
          });
        }
        continue;
      }
      if (ev.type === 'command/done') {
        const d: any = ev.data || {};
        if (!paused && d.text) {
          emit({
            type: 'timeline.item',
            sessionId: paseoId,
            item: { type: 'assistant_message', id: `cmd-done-${d.commandId || ev.seq}`, text: String(d.text) },
            timestamp: ev.time ? new Date(ev.time).toISOString() : undefined,
          });
        }
        if (!paused) void refreshObserverUsage();
        continue;
      }
      if (ev.type === 'compaction/end') { if (!paused) void refreshObserverUsage(); continue; }
      // 自有回合进行中：连接保留（游标照常前进，恢复后不会回放），输出交给 runTurn
      if (paused) continue;
      const key = `${(ev.data as any)?.turn}:${(ev.data as any)?.step}`;
      const items = toTimeline(ev, pending);
      if (!items.length) continue;
      preview.flush();
      for (const item of items) {
        if (item.type === 'assistant_message' && preview.hasText(key)) continue;
        if (item.type === 'reasoning' && preview.hasReasoning(key)) continue;
        emit({
          type: 'timeline.item',
          sessionId: paseoId,
          item,
          timestamp: ev.time ? new Date(ev.time).toISOString() : undefined,
        });
      }
    }
    if (state.observers.get(paseoId) === entry) {
      state.observers.delete(paseoId);
      state.observedTurns.delete(paseoId);
    }
  })();
}

function flushPending(pending: Map<string, any>, paseoId: string, emit: Emit) {
  for (const [callId, p] of pending) {
    if (!p.settled) settleToolFailure(callId, p, paseoId, emit, 'tool result not received before turn end');
  }
  pending.clear();
}

/** assistant-stream 实时预览：reasoning 首块立即发、之后每 ~40 字增量；正文按 block 落定。
 *  Paseo bridge 按 item.id 只转发新增文本，所以 id 稳定 + 文本累计。 */
function createPreviewStreamer(paseoId: string, emit: Emit) {
  const st = {
    step: '',
    reasoning: '',
    text: '',
    tSeq: 0,
    rAcc: new Map<string, string>(),
    tAcc: new Map<string, string>(),
  };
  const emitReasoning = () => {
    if (!st.step || !st.reasoning) return;
    const prev = st.rAcc.get(st.step) || '';
    if (st.reasoning === prev) return;
    st.rAcc.set(st.step, st.reasoning);
    emit({
      type: 'timeline.item',
      sessionId: paseoId,
      item: { type: 'reasoning', id: `rs-${st.step}`, text: st.reasoning },
    });
  };
  const emitText = () => {
    if (!st.step || !st.text) return;
    const text = st.text;
    st.text = '';
    st.tAcc.set(st.step, (st.tAcc.get(st.step) || '') + text);
    emit({
      type: 'timeline.item',
      sessionId: paseoId,
      item: { type: 'assistant_message', id: `as-${st.step}-${st.tSeq++}`, text },
    });
  };
  const flush = () => {
    emitReasoning();
    emitText();
  };
  const frame = (f: any) => {
    if (!f) return;
    // usage chunk 可能不带 turn/step，先处理再进 step 守卫
    if (f.type === 'chunk' && f.chunk?.type === 'usage') {
      emitUsage(emit, paseoId, usageFromChunk(f.chunk));
      return;
    }
    // chunk 帧本身不带 turn/step，只有 start 帧带；key 必须沿用 start 的值，
    // 否则会和最终 assistant/message 的 key 对不上（实测曾退化成 "?:?" 导致重复）。
    if (f.turn != null && f.step != null) {
      const key = `${f.turn}:${f.step}`;
      if (st.step && key !== st.step) {
        flush();
        st.reasoning = '';
        st.text = '';
      }
      st.step = key;
    }
    if (!st.step) return;
    if (f.type === 'chunk') {
      const c = f.chunk || {};
      const t = typeof c.text === 'string' ? c.text : '';
      if (c.type === 'reasoning-delta' && t) {
        st.reasoning += t;
        const prevLen = (st.rAcc.get(st.step) || '').length;
        if (prevLen === 0 || st.reasoning.length - prevLen >= 40) emitReasoning();
      } else if (c.type === 'text-delta' && t) {
        // 正文攒到 block-end 一次落定：分块合并会在块边界插入换行，破坏最终排版。
        st.text += t;
      } else if (c.type === 'block-end' || c.type === 'finish') {
        flush();
      }
    } else if (f.type === 'end') {
      flush();
    }
  };
  return {
    frame,
    flush,
    hasText: (key: string) => st.tAcc.has(key),
    textOf: (key: string) => st.tAcc.get(key) || '',
    hasReasoning: (key: string) => st.rAcc.has(key),
  };
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
    content?: DshPromptBlock[];
    mode?: 'queue' | 'steer';
    startPhase?: 'waitEcho' | 'running';
    replyIdleTicks?: number;
    turnIdOverride?: string;
    suppressTurnStart?: boolean;
    onStarted?: () => void;
    onTurn?: (turnId: string, state: string) => void;
  } = {},
): Promise<{ reason: string; reconnects: number; interrupted: boolean }> {
  const ep = await getDshEndpoint().catch(() => null);
  let connect: ((url: string) => any) | undefined;
  if (ep?.cookie) {
    const { WebSocket: WsWebSocket } = await import('ws');
    const cookie = ep.cookie;
    connect = (url) => new WsWebSocket(url, { headers: { cookie } });
  }
  // 鉴权断了要一句话说清（2026-11-10 真机：DSH 被 open -a 启动 → 不写新 token →
  // 换不到 cookie → 所有 RPC 401 → follow 拿不到快照 → 用户只看到 first snapshot timeout）
  if (!deps.follow && ep && !ep.cookie && ep.source === 'discovered-no-cookie') {
    throw new Error(
      'DSH 鉴权失效：launch token 换不到 cookie（多半是 DSH 用 open -a/直接双击启动的，没写新的 dsh web token）。'
      + '用 launchd 重启 DSH（launchctl kickstart -k gui/$(id -u)/'
      + (process.env.DSH_LAUNCHD_LABEL || '<DSH 的 launchd label>')
      + '），再 paseo plugin reload dsh-provider',
    );
  }
  const follow = (deps.follow || followSession)(dshId, {
    assistantStream: true,
    readyTimeoutMs: 15_000,
    ...(ep ? { url: ep.mux } : {}),
    ...(connect ? { connect, headers: { cookie: ep?.cookie as string } } : {}),
    // 断线重连时重新解析端点：DSH 重启会换 cookie，端口也可能变
    ...(deps.follow ? {} : { resolveEndpoint: endpointResolver }),
  });
  const now = deps.now || Date.now;
  const startedAt = now();
  const pending = new Map<string, any>();
  const notices = new Set<string>();
  let noticeSeq = 0;
  let reason = 'completed';
  let reconnects = 0;
  let lastDisconnectAt = 0;
  let interrupted = false;
  let failure: string | undefined;
  let timer: ReturnType<typeof setInterval> | null = null;

  const preview = createPreviewStreamer(paseoId, emit);

  const onAbort = () => {
    reason = 'canceled';
    try { follow.close(); } catch {}
  };
  deps.signal?.addEventListener('abort', onAbort, { once: true });

  // 上下文占用刷新：面板只吃 session.usage 事件，所以「回合结束才发」会显得很迟钝。
  // 这里按 3s 节流拉一次单会话 projections；值没变就不发。
  let lastUsageJson = '';
  let usageInFlight = false;
  const refreshUsage = async (opts: { force?: boolean } = {}) => {
    if (usageInFlight) return;
    usageInFlight = true;
    try {
      const ctx = await sessionContextUsage(dshId).catch(() => null);
      if (!ctx) return;
      const key = JSON.stringify(ctx);
      if (!opts.force && key === lastUsageJson) return;
      lastUsageJson = key;
      emitUsage(emit, paseoId, ctx);
    } finally {
      usageInFlight = false;
    }
  };

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
        preview.flush();
        const ev = a.event as DshEvent;
        const key = `${(ev.data as any)?.turn}:${(ev.data as any)?.step}`;
        for (const item of toTimeline(ev, pending)) {
          // 该 step 已有流式预览 → 最终件一律不再发，避免重复。
          if (item.type === 'assistant_message' && preview.hasText(key)) {
            if (normText(item.text) !== normText(preview.textOf(key))) {
              notice(`stream/final 文本不一致（step ${key}），以流式预览为准`);
            }
            continue;
          }
          if (item.type === 'reasoning' && preview.hasReasoning(key)) continue;
          emit({
            type: 'timeline.item',
            sessionId: paseoId,
            item,
            timestamp: ev.time ? new Date(ev.time).toISOString() : undefined,
          });
        }
      } else if (a.type === 'turn') {
        const turnId = deps.turnIdOverride || `dsh-turn-${a.turn ?? '?'}`;
        deps.onTurn?.(turnId, a.state);
        if (!(a.state === 'started' && deps.suppressTurnStart)) {
          emit({ type: 'session.turn', sessionId: paseoId, turnId, state: a.state });
        }
      } else if (a.type === 'notice') {
        notice(a.message, a.level);
      } else if (a.type === 'done') {
        reason = a.reason;
      }
    }
  };

  let state: ReturnType<typeof createTurnState> | null = null;
  try {
    const snap = await follow.ready.catch((e) => {
      if (deps.signal?.aborted) return null;
      throw e;
    });
    if (!snap) return { reason: 'canceled', reconnects, interrupted };

    const turnState = createTurnState({
      promptText: text,
      startSeq: snap.cursor,
      now: now(),
      echoTimeoutMs: deps.echoTimeoutMs ?? 15_000,
      // 不传 budgetMs / replyIdleTicks 时用状态机默认值（6h / ~10min）；
      // 这里不要再写 120s/5tick 兜底，否则会把长 goal 轮次误杀。
      ...(deps.budgetMs !== undefined ? { budgetMs: deps.budgetMs } : {}),
      startPhase: deps.startPhase ?? 'waitEcho',
      ...(deps.replyIdleTicks !== undefined ? { replyIdleTicks: deps.replyIdleTicks } : {}),
      // 每轮 follow 的首个快照都会 hasMore=true；截断只在打开/回放历史时提示一次
      noticeTruncation: false,
    });
    state = turnState;
    handle(turnState.onSnapshot(snap));
    await (deps.prompt || promptSession)(dshId, deps.content ?? text, deps.mode ?? 'queue');
    deps.onStarted?.();
    void refreshUsage({ force: true });

    let lastUsageAt = now();
    timer = setInterval(() => {
      const at = now();
      for (const [callId, p] of [...pending]) {
        if (!p.settled && p.time && at - p.time > (deps.toolTimeoutMs ?? 60_000)) {
          settleToolFailure(callId, p, paseoId, emit, 'tool result timeout (60s)');
          // 只结算卡片，不把工具从 pending 里摘掉：它可能还在跑，
          // 摘掉会让 idle 兜底把长工具误判成本轮结束。
          p.settled = true;
        }
      }
      handle(turnState.onTick(at, { busy: pending.size > 0 }));
      if (at - lastUsageAt >= 3_000) { lastUsageAt = at; void refreshUsage(); }
      if (turnState.phase === 'done') { try { follow.close(); } catch {} }
    }, deps.tickMs ?? 1000);

    for await (const msg of follow) {
      if (msg.kind === 'event') {
        const evType = (msg.event as any)?.type;
        if (evType === 'compaction/start') notice('正在压缩上下文…', 'info');
        else if (evType === 'compaction/end') { notice('上下文已压缩'); void refreshUsage({ force: true }); }
        handle(turnState.onEvent(msg.event));
      }
      else if (msg.kind === 'assistant') {
        preview.frame(msg.frame);
        handle(turnState.onAssistantFrame(msg.frame));
      } else if (msg.kind === 'snapshot') handle(turnState.onSnapshot(msg));
      else if (msg.kind === 'reset' || msg.kind === 'truncated') { /* state 已按 snapshot 发 notice */ }
      else if (msg.kind === 'gap') {
        notice(`重连期间可能丢失事件：seq ${msg.from} → ${msg.to}`);
      } else if (msg.kind === 'unknown') {
        if (!notices.has(msg.valueType)) {
          notices.add(msg.valueType);
          notice(`未知 mux 帧类型：${msg.valueType}`);
        }
      } else if (msg.kind === 'error') {
        if (msg.reconnecting) reconnects++;
        lastDisconnectAt = now();
        logWarn('follow error', {
          session: paseoId,
          dsh: dshId,
          attempt: reconnects,
          reconnecting: msg.reconnecting !== false,
          error: String(msg.error instanceof Error ? msg.error.message : msg.error),
        });
        if (!notices.has('follow-error')) {
          notices.add('follow-error');
          notice('DSH 连接中断，正在自动重连（回合会继续）');
        }
      }
      if (turnState.phase === 'done' || deps.signal?.aborted) break;
    }
    if (deps.signal?.aborted) reason = 'canceled';
    // 断线后 60s 内就收工：大概率是 DSH 桌面端重启把回合掐断，而不是模型正常结束。
    // 这一条以前完全没有痕迹，Paseo 侧只显示 "Provider turn failed"。
    if (reason !== 'completed' && reconnects > 0 && now() - lastDisconnectAt < 60_000) {
      interrupted = true;
      notice('DSH 桌面端重启/连接中断导致本轮提前结束；已产出的内容保留，可直接重发', 'warning');
    }
  } catch (e) {
    // 抛错路径以前会把 reason 留在 'completed'，日志看着像正常收工（2026-11-10 踩到）
    failure = errorMessage(e);
    if (!deps.signal?.aborted) reason = 'failed';
    throw e;
  } finally {
    deps.signal?.removeEventListener('abort', onAbort);
    if (timer) clearInterval(timer);
    preview.flush();
    try { follow.close(); } catch {}
    flushPending(pending, paseoId, emit);
    // abort / 抛错路径也必须更新占用（以前只在成功分支发，面板会一直停在旧值）
    await refreshUsage({ force: true }).catch(() => {});
    const level = reason === 'completed' && !interrupted ? 'info' : 'warn';
    const fields = {
      session: paseoId,
      dsh: dshId,
      reason,
      ...(failure ? { error: failure } : {}),
      interrupted,
      reconnects,
      durationMs: now() - startedAt,
      lastSeq: state ? state.lastSeq : -1,
      pendingTools: pending.size,
    };
    if (level === 'info') logInfo('turn end', fields);
    else logWarn('turn end', fields);
  }
  return { reason, reconnects, interrupted };
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
  logDebug('stream ended', { seq: lastSeq, replyText: sawReplyText, turnEnd: sawTurnEnd });
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

/** 从 Paseo 的 prompt 结构里抽文本 + 图片块（实测文本在 prompt.input.content[]）。
 *  Paseo 的图片是 {type:'image', data, mimeType}，DSH 的字段叫 mediaType（真机验证）。
 *  其余附件类型降级成一行文本说明，至少不丢。 */
function extractContent(prompt: any): { blocks: DshPromptBlock[]; text: string } {
  const parts =
    prompt?.input?.content ?? prompt?.content ?? prompt?.message?.content ?? prompt?.blocks ?? [];
  const rawText: string[] = [];
  const blocks: DshPromptBlock[] = [];
  if (typeof prompt?.text === 'string') {
    rawText.push(prompt.text);
  } else if (Array.isArray(parts)) {
    for (const b of parts) {
      if (!b || typeof b !== 'object') continue;
      if ((b.type === 'text' || b.type === 'plain_text') && typeof b.text === 'string') {
        rawText.push(b.text);
      } else if (b.type === 'image' && typeof b.data === 'string') {
        blocks.push({ type: 'image', data: b.data, mediaType: b.mimeType || b.mediaType || 'image/png' });
      } else if (b.type) {
        const label = b.fileName || b.title || b.name || b.url || b.id || '';
        blocks.push({ type: 'text', text: `[附件:${b.type}] ${label}`.trim() });
      }
    }
  }
  // 去掉 Paseo 注入的 <paseo-system …>…</paseo-system> 包装，只留用户真正说的话
  const text = rawText
    .join('\n')
    .replace(/<\/?paseo-system[^>]*>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text) blocks.unshift({ type: 'text', text });
  return { blocks, text };
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
