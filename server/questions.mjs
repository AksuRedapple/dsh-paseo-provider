/**
 * DSH 提问 ↔ Paseo 提问卡（纯函数，无 I/O）。
 *
 * 两侧形状（2026-11-25 逆出）：
 *  · DSH `user-questions/request` 的 questions：
 *      { id, question, detail?, header?, options?: [{label, description?}], multiSelect? }
 *    答：{ answers: [{ id, selected: [label...], custom?: string }] }
 *  · Paseo `session.permission`（kind='question'）的 request.input.questions：
 *      { question, header, options: [{label, description?, preview?}], multiSelect,
 *        allowOther?, allowEmpty?, placeholder?, dismissLabel? }
 *    答：{ behavior:'allow', updatedInput:{ ...input, answers: { [header]: "label" | "a, b" | "自由文本" } } }
 *    多选以 ", " 拼接；空串表示「跳过这题」。
 *
 * 两处必做的翻译：
 *  1. Paseo 要求 header 是**非空且唯一**的字符串，DSH 的 header 可省略 → 兜底 + 去重。
 *  2. Paseo 的回包以 **header 为键**，DSH 要按 **id** 对位 → 回包时反查。
 */

/** DSH 的提问工具名（回包时也用它认领「这条 tool/result 属于提问」）。 */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question';

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const DEFAULT_PLACEHOLDER_FREE = '输入回答…';
const DEFAULT_PLACEHOLDER_OTHER = '其他（可选）';

/**
 * DSH questions → Paseo 卡片的 questions。
 * @param {any[]} questions
 * @returns {Array<Record<string, any>>}
 */
export function mapQuestions(questions) {
  const used = new Set();
  const list = Array.isArray(questions) ? questions : [];
  return list.map((q, i) => {
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => ({
        label: text(o?.label),
        ...(text(o?.description) ? { description: text(o.description) } : {}),
      }))
      .filter((o) => o.label);

    // header：Paseo 必填且按它回包，必须稳定 + 唯一
    let header = text(q?.header) || `Q${i + 1}`;
    if (used.has(header)) {
      let n = 2;
      while (used.has(`${header} (${n})`)) n += 1;
      header = `${header} (${n})`;
    }
    used.add(header);

    const subject = text(q?.question) || `问题 ${i + 1}`;
    const detail = text(q?.detail);
    const free = options.length === 0;

    return {
      id: text(q?.id) || `q${i + 1}`,
      header,
      question: detail ? `${subject}\n\n${detail}` : subject,
      options,
      multiSelect: q?.multiSelect === true,
      // 有选项时允许「其他」自由作答；没有选项时整题就是自由作答
      ...(free ? { allowOther: true, allowEmpty: true, placeholder: DEFAULT_PLACEHOLDER_FREE }
        : { allowOther: true, placeholder: DEFAULT_PLACEHOLDER_OTHER }),
    };
  });
}

/**
 * 一条 waterfall 帧 → Paseo `session.permission` 的 request。
 * @param {{permissionId: string, eventId: string, questions: any[]}} input
 */
export function questionPermission({ permissionId, eventId, questions }) {
  return {
    id: permissionId,
    name: ASK_USER_QUESTION_TOOL,
    kind: 'question',
    title: 'DSH 提问',
    input: { questions: mapQuestions(questions) },
    metadata: { dshEventId: eventId },
  };
}

/**
 * Paseo 的权限回包 → `$events/result` 的 outcome。
 * @param {Array<Record<string, any>>} mapped mapQuestions 的产物
 * @param {any} response ProviderPermissionResponse
 * @returns {{kind: 'result', value: {answers: any[]}} | {kind: 'rejected', error: any}}
 */
export function toDshOutcome(mapped, response) {
  if (!response || response.behavior !== 'allow') {
    return {
      kind: 'rejected',
      error: {
        name: 'UserQuestionError',
        message: text(response?.message) || 'the user dismissed ask_user_question',
        code: 'ASK_CANCELLED',
      },
    };
  }
  const supplied = response.updatedInput?.answers;
  const byHeader = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied : {};
  const answers = (Array.isArray(mapped) ? mapped : []).map((q) => {
    const raw = text(byHeader[q.header]);
    const labels = q.options.map((o) => o.label);
    if (!raw) return { id: q.id, selected: [] };
    if (!q.multiSelect) {
      // 单选：命中选项就当选择，否则整串当自由文本
      return labels.includes(raw)
        ? { id: q.id, selected: [raw] }
        : { id: q.id, selected: [], custom: raw };
    }
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const selected = parts.filter((p) => labels.includes(p));
    const custom = parts.filter((p) => !labels.includes(p)).join(', ');
    return { id: q.id, selected, ...(custom ? { custom } : {}) };
  });
  return { kind: 'result', value: { answers } };
}
