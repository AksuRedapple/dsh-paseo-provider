/**
 * turn-state —— WS provider 的「一轮对话何时结束」状态机（纯逻辑，无 I/O）。
 *
 * 输入：snapshot / DSH event / assistant-stream frame / tick(now)
 * 输出：actions（timeline / turn / notice / echo / done），由调用方转换成各自协议。
 */

export const TIMELINE_EVENTS = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'todo/write', 'goal/change']);
export const TURN_EVENTS = new Set(['turn/start', 'turn/end']);
export const IGNORED_EVENTS = new Set([
  'step/start', 'step/end', 'assistant/attempt',
  'request/header', 'request/context',
  'session/title', 'session/title-llm-request',
  'agent/inbox/spliced', 'job/registered', 'job/settled',
  'system/message', 'developer/message', 'workspace/changes',
  'permission/preset', 'sandbox/mode', 'approval/policy',
  'session/end-seed',
]);

/** 事件分类：timeline / turn / ignore / unknown */
export function classifyEvent(type) {
  if (TIMELINE_EVENTS.has(type)) return 'timeline';
  if (TURN_EVENTS.has(type)) return 'turn';
  if (IGNORED_EVENTS.has(type)) return 'ignore';
  return 'unknown';
}

/** assistant/message 是否带正文（tool-call 消息不算回复）。 */
export function hasAssistantText(ev) {
  const content = ev?.data?.message?.content;
  return Array.isArray(content) &&
    content.some((c) => c && c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0);
}

function userText(ev) {
  const content = ev?.data?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text).join('\n');
}

/**
 * @param {{
 *   promptText?: string,
 *   startSeq: number,
 *   now: number,
 *   echoTimeoutMs?: number,
 *   budgetMs?: number,
 *   replyIdleTicks?: number,
 *   startPhase?: 'waitEcho' | 'running',
 *   noticeTruncation?: boolean,
 * }} opts
 */
export function createTurnState(opts) {
  const {
    promptText = '',
    startSeq,
    now,
    echoTimeoutMs = 15_000,
    budgetMs = 120_000,
    replyIdleTicks = 5,
    startPhase = 'waitEcho',
    noticeTruncation = true,
  } = opts;
  if (typeof startSeq !== 'number') {
    throw new Error('createTurnState: startSeq 必须显式传入');
  }
  const needle = promptText.trim().slice(0, 40);
  const echoDeadline = now + echoTimeoutMs;
  const deadline = now + budgetMs;

  let phase = startPhase === 'running' ? 'running' : 'waitEcho'; // waitEcho | running | done
  let lastSeq = startSeq;
  let sawReplyText = false;
  let idle = 0;
  let echoSeen = false;
  let truncated = false;
  const unknownSeen = new Set();

  const out = [];
  const push = (a) => out.push(a);

  function done(reason, detail) {
    if (phase === 'done') return;
    phase = 'done';
    push({ type: 'done', reason, detail });
  }

  function notice(message, level = 'warning') {
    push({ type: 'notice', level, message });
  }

  return {
    get phase() { return phase; },
    get lastSeq() { return lastSeq; },
    get sawReplyText() { return sawReplyText; },
    get echoSeen() { return echoSeen; },

    onSnapshot(snapshot) {
      const cursor = Number(snapshot?.cursor);
      if (Number.isFinite(cursor) && cursor < lastSeq) {
        notice(`DSH seq 重置：${lastSeq} → ${cursor}，以新游标为基线（不回放历史）`);
        push({ type: 'reset', from: lastSeq, to: cursor });
        lastSeq = cursor;
      } else if (Number.isFinite(cursor)) {
        lastSeq = Math.max(lastSeq, cursor);
      }
      if (snapshot?.hasMore && !truncated) {
        truncated = true;
        if (noticeTruncation) notice('DSH 快照被截断（hasMore=true），历史不完整；实时流不受影响');
        push({ type: 'truncated', cursor: lastSeq });
      }
      return out.splice(0);
    },

    onEvent(ev) {
      if (phase === 'done' || !ev) return out.splice(0);
      const seq = Number(ev.seq);
      if (Number.isFinite(seq)) {
        if (seq <= lastSeq) return out.splice(0); // 重复帧
        lastSeq = seq;
      }
      idle = 0;

      const kind = classifyEvent(ev.type);
      if (kind === 'unknown') {
        if (!unknownSeen.has(ev.type)) {
          unknownSeen.add(ev.type);
          notice(`未知 DSH 事件类型：${ev.type}（seq ${seq}），已忽略并计数`);
          push({ type: 'unknown', eventType: ev.type, seq });
        }
        return out.splice(0);
      }

      if (ev.type === 'user/message') {
        const text = userText(ev);
        if (!echoSeen && needle && text.includes(needle)) {
          echoSeen = true;
          phase = 'running';
          push({ type: 'echo', seq });
          return out.splice(0);
        }
        // DSH 会以 user/message 注入大量上下文（system-reminder / ssot-context / 时间戳）。
        // 只有 source.kind=user/agent 才是真正对用户可见的消息。
        const sourceKind = ev.data?.source?.kind;
        if (sourceKind !== 'user' && sourceKind !== 'agent') return out.splice(0);
      }

      if (ev.type === 'assistant/message' && hasAssistantText(ev)) {
        sawReplyText = true;
        if (phase === 'waitEcho') phase = 'running'; // echo 丢了也继续
      }

      if (kind === 'timeline') push({ type: 'timeline', event: ev });

      if (ev.type === 'turn/start') {
        push({ type: 'turn', state: 'started', turn: ev.data?.turn });
      } else if (ev.type === 'turn/end') {
        const reason = ev.data?.reason?.kind;
        const state = reason === 'completed' ? 'completed'
          : (reason === 'canceled' || reason === 'aborted') ? 'canceled'
          : 'failed';
        push({ type: 'turn', state, turn: ev.data?.turn });
        done(state === 'completed' ? 'completed' : state, ev.data?.reason);
      }
      return out.splice(0);
    },

    onAssistantFrame(frame) {
      if (phase === 'done' || !frame) return out.splice(0);
      idle = 0;
      if (frame.type === 'start') {
        push({ type: 'reply_started', turn: frame.turn, step: frame.step, startedAfterSeq: frame.startedAfterSeq });
      } else if (frame.type === 'end' && frame.outcome) {
        push({ type: 'reply_ended', outcome: frame.outcome });
      }
      return out.splice(0);
    },

    /** 调用方每 tickMs 调一次；驱动 echo 超时、总超时、无 turn/end 的兜底收工。 */
    onTick(at = Date.now()) {
      if (phase === 'done') return out.splice(0);
      if (phase === 'waitEcho' && at >= echoDeadline) {
        phase = 'running';
        notice('等待用户消息落库超时（15s），从当前水位继续（宁可少回放不回声）');
        push({ type: 'echo_timeout', seq: lastSeq });
      }
      if (at >= deadline) {
        notice('本轮流式预算耗尽（120s）');
        done('timeout');
        return out.splice(0);
      }
      if (phase === 'running' && sawReplyText) {
        idle++;
        if (idle >= replyIdleTicks) done('completed');
      }
      return out.splice(0);
    },
  };
}
