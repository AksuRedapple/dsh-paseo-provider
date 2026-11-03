/** DSH event → ACP session/update 的纯映射（可单测，不碰 I/O）。 */

export const textOf = (blocks) =>
  (blocks || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');

/** ACP prompt content → DSH content。图片字段：ACP 叫 mimeType，DSH 叫 mediaType。 */
export function contentOf(blocks) {
  const out = [];
  const texts = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text);
    } else if (b.type === 'image' && typeof b.data === 'string') {
      out.push({ type: 'image', data: b.data, mediaType: b.mimeType || b.mediaType || 'image/png' });
    } else if (b.type === 'resource_link' || b.type === 'resource') {
      const label = b.name || b.title || b.uri || b.resource?.uri || '';
      out.push({ type: 'text', text: `[附件:${b.type}] ${label}`.trim() });
    }
  }
  const text = texts.join('\n');
  if (text) out.unshift({ type: 'text', text });
  return { blocks: out, text };
}

const pick = (content, type) =>
  (Array.isArray(content) ? content : [])
    .filter((c) => c && c.type === type && typeof c.text === 'string')
    .map((c) => c.text).join('');

/** DSH 工具名 + arguments → ACP kind / rawInput（字段名按 Paseo 的展示约定）。 */
function acpToolInput(name, raw) {
  let args = {};
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
  } catch {
    args = { raw: String(raw ?? '') };
  }
  if (!args || typeof args !== 'object') args = { raw: String(args ?? '') };
  const n = String(name || '').toLowerCase();
  const file = args.file_path || args.path || args.filePath || '';
  if (n.includes('bash') || n.includes('shell') || n.includes('exec')) {
    return { kind: 'execute', input: { command: String(args.command ?? '') } };
  }
  if (n === 'read' || n.includes('read_file')) {
    return {
      kind: 'read',
      input: {
        filePath: String(file),
        ...(args.offset != null ? { offset: args.offset } : {}),
        ...(args.limit != null ? { limit: args.limit } : {}),
      },
    };
  }
  if (n === 'write' || n.includes('write_file')) {
    return { kind: 'edit', input: { filePath: String(file), content: String(args.content ?? '') } };
  }
  if (n === 'edit' || n.includes('str_replace')) {
    return {
      kind: 'edit',
      input: {
        filePath: String(file),
        oldString: String(args.old_string ?? ''),
        newString: String(args.new_string ?? ''),
      },
    };
  }
  if (n.includes('grep') || n.includes('search') || n.includes('glob')) {
    return { kind: 'search', input: { query: String(args.query ?? args.pattern ?? '') } };
  }
  return { kind: 'other', input: args };
}

/** 历史回放用：user / assistant(reasoning+text) / tool call（pending）。 */
export function acpUpdates(ev) {
  const d = ev?.data || {};
  if (ev.type === 'user/message') {
    const t = pick(d.content, 'text');
    return t ? [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: t } }] : [];
  }
  if (ev.type === 'assistant/message') {
    const c = d?.message?.content;
    const out = [];
    const r = pick(c, 'reasoning');
    if (r) out.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: r } });
    const t = pick(c, 'text');
    if (t) out.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
    return out;
  }
  if (ev.type === 'tool/call') {
    const { kind, input } = acpToolInput(d.name, d.arguments);
    return [{
      sessionUpdate: 'tool_call',
      toolCallId: String(d.callId || ev.seq),
      title: String(d.name || 'tool'),
      kind,
      status: 'pending',
      rawInput: input,
    }];
  }
  if (ev.type === 'todo/write') {
    // ACP 的 plan：每次发完整列表，客户端整体替换
    const entries = (Array.isArray(d.todos) ? d.todos : [])
      .filter((t) => t && t.content)
      .map((t) => ({
        content: String(t.content),
        priority: 'medium',
        status: t.status === 'completed' ? 'completed'
          : t.status === 'in_progress' ? 'in_progress' : 'pending',
      }));
    return [{ sessionUpdate: 'plan', entries }];
  }
  return [];
}

/** 实时路径：tool/result → tool_call_update（completed + 文本输出）。 */
export function toolResultUpdate(ev) {
  const d = ev?.data || {};
  const callId = String(d.toolCallId || d?.message?.source?.callId || ev.seq || '');
  const text = pick(d?.message?.content, 'text');
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status: 'completed',
    // Paseo 用 rawOutput 填工具卡片的 output；只给 content 时卡片会空
    rawOutput: text,
    content: text ? [{ type: 'content', content: { type: 'text', text } }] : [],
  };
}

/**
 * DSH usage chunk → ACP usage_update。
 *
 * DSH 实测字段（camelCase）：inputTokens 不含缓存、cacheReadTokens 是命中的缓存、
 * totalTokens 含缓存与输出。ACP 的 used 语义是「当前上下文里的 token 数」，
 * 与 DSH 的 contextPressure.pressureTokens 对齐 = inputTokens + cacheReadTokens。
 * size 来自 session/list 的 projections.contextPressure.contextWindow；
 * 拿不到就不发（宁可不显示，也不编一个假的上下文窗口）。
 */
export function acpUsageUpdate(chunk, size) {
  const u = chunk?.usage || chunk?.usageMetadata || chunk || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const uncached = num(u.inputTokens) ?? num(u.input_tokens) ?? num(u.promptTokenCount);
  const cached = num(u.cacheReadTokens) ?? num(u.cache_read_input_tokens) ?? num(u.cachedContentTokenCount) ?? 0;
  const used = uncached != null ? uncached + cached : num(u.totalTokens);
  if (used == null || typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null;
  const cost =
    typeof u.totalCostUsd === 'number' && Number.isFinite(u.totalCostUsd)
      ? { amount: u.totalCostUsd, currency: 'USD' }
      : undefined;
  return { sessionUpdate: 'usage_update', used, size, ...(cost ? { cost } : {}) };
}
