/** DSH event → ACP session/update 的纯映射（可单测，不碰 I/O）。 */

export const textOf = (blocks) =>
  (blocks || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');

const pick = (content, type) =>
  (Array.isArray(content) ? content : [])
    .filter((c) => c && c.type === type && typeof c.text === 'string')
    .map((c) => c.text).join('');

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
    return [{
      sessionUpdate: 'tool_call',
      toolCallId: String(d.callId || ev.seq),
      title: String(d.name || 'tool'),
      kind: 'other',
      status: 'pending',
    }];
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
    content: text ? [{ type: 'content', content: { type: 'text', text } }] : [],
  };
}
