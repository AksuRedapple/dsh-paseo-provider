/**
 * DSH 模型目录 → Paseo / ACP 的纯映射（可单测，不碰 I/O）。
 *
 * 实测 DSH 的形状（2026-11-03）：
 *   { default:{provider,model,reasoningEffort?}, groups:[{id,name,models:[{id,name,description?,reasoning:{efforts:[{id,name,description?}],defaultEffort?}}]}] }
 *
 * Paseo 的模型 id 只有一个字符串、ACP 的 model 值也只有一个字符串，
 * 而 DSH 的模型由 (provider, model) 二元组唯一确定 → 用 "provider::model" 编码。
 */

export const MODEL_SEP = '::';

export const encodeModelId = (provider, model) => `${provider}${MODEL_SEP}${model}`;

/** "deepseek-official::deepseek-v4-pro" → {provider, model}；不合法返回 null。 */
export function parseModelId(id) {
  const s = String(id ?? '');
  const i = s.indexOf(MODEL_SEP);
  if (i <= 0 || i + MODEL_SEP.length >= s.length) return null;
  return { provider: s.slice(0, i), model: s.slice(i + MODEL_SEP.length) };
}

function catalogEntries(cat) {
  const out = [];
  for (const g of cat?.groups || []) {
    for (const m of g?.models || []) {
      if (g?.id && m?.id) out.push({ provider: g.id, providerName: g.name || g.id, model: m });
    }
  }
  return out;
}

function toThinkingOptions(model) {
  return (model?.reasoning?.efforts || [])
    .filter((e) => e?.id)
    .map((e) => ({
      id: e.id,
      label: e.name || e.id,
      ...(e.description ? { description: e.description } : {}),
      ...(model?.reasoning?.defaultEffort === e.id ? { isDefault: true } : {}),
    }));
}

/** 目录 → Paseo ProviderModel[]（thinkingOptions 挂在各自模型下）。 */
export function catalogModels(cat) {
  return catalogEntries(cat).map(({ provider, providerName, model: m }) => {
    const thinkingOptions = toThinkingOptions(m);
    return {
      id: encodeModelId(provider, m.id),
      label: m.name ? `${m.name} · ${providerName}` : m.id,
      ...(m.description ? { description: m.description } : {}),
      metadata: { provider, model: m.id },
      ...(thinkingOptions.length
        ? {
            thinkingOptions,
            ...(m.reasoning?.defaultEffort ? { defaultThinkingOptionId: m.reasoning.defaultEffort } : {}),
          }
        : {}),
    };
  });
}

/** 目录默认模型 + 完整模型列表（catalog 事件与 session.config 共用）。 */
export function catalogDefaults(cat) {
  const models = catalogModels(cat);
  const d = cat?.default;
  const defaultModel = d?.provider && d.model ? encodeModelId(d.provider, d.model) : models[0]?.id;
  const entry = models.find((m) => m.id === defaultModel);
  return {
    models,
    defaultModel,
    defaultThinkingOption: d?.reasoningEffort || entry?.defaultThinkingOptionId,
  };
}

/** 按 (provider, model) 找目录里的原始条目（拿 reasoning efforts 用）。 */
export function findCatalogModel(cat, provider, model) {
  return catalogEntries(cat).find((e) => e.provider === provider && e.model.id === model) || null;
}

/** 某模型可选的 reasoning effort 列表。 */
export function thinkingOptionsFor(cat, ref) {
  if (!ref?.provider || !ref?.model) return [];
  return toThinkingOptions(findCatalogModel(cat, ref.provider, ref.model)?.model);
}

/** 会话条目（session/list）里的当前模型；next 是下一轮将用的选择。 */
export function sessionModelRef(item) {
  const v = item?.projections?.values ?? {};
  const m = v.modelSelection?.next ?? v.modelSelection?.lastUsed ?? null;
  if (!m || typeof m.provider !== 'string' || typeof m.model !== 'string') return null;
  return {
    provider: m.provider,
    model: m.model,
    ...(typeof m.reasoningEffort === 'string' && m.reasoningEffort ? { reasoningEffort: m.reasoningEffort } : {}),
  };
}

/** 会话条目的上下文窗口（来自 projections.contextPressure，实测 1_000_000）。 */
export function contextWindowOf(item) {
  const w = item?.projections?.values?.contextPressure?.contextWindow;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : undefined;
}

/** Paseo session.config 事件载荷（ProviderConfigState）。 */
export function toProviderConfig(cat, current) {
  const { models, defaultModel, defaultThinkingOption } = catalogDefaults(cat);
  const thinkingOptions = thinkingOptionsFor(cat, current);
  const model = current ? encodeModelId(current.provider, current.model) : defaultModel;
  const thinkingOption =
    current?.reasoningEffort || thinkingOptions.find((o) => o.isDefault)?.id || defaultThinkingOption;
  return {
    ...(model ? { model } : {}),
    ...(thinkingOption ? { thinkingOption } : {}),
    models,
    modes: [{ id: 'default', label: 'default' }],
    thinkingOptions,
    settings: [],
  };
}

/** ACP session/new、session/load、set_config_option 共用的 configOptions。 */
export function acpConfigOptions(cat, current) {
  const { models, defaultModel } = catalogDefaults(cat);
  if (!models.length) return [];
  const currentValue = current ? encodeModelId(current.provider, current.model) : defaultModel;
  const options = models.map((m) => ({
    value: m.id,
    name: m.label,
    ...(m.description ? { description: m.description } : {}),
  }));
  if (currentValue && !options.some((o) => o.value === currentValue)) {
    options.unshift({ value: currentValue, name: current?.model || currentValue });
  }
  const out = [
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue,
      options,
    },
  ];
  const ref = current || parseModelId(defaultModel);
  const efforts = thinkingOptionsFor(cat, ref);
  if (efforts.length) {
    const preset = current?.reasoningEffort || efforts.find((e) => e.isDefault)?.id || efforts[0].id;
    out.push({
      type: 'select',
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      currentValue: preset,
      options: efforts.map((e) => ({
        value: e.id,
        name: e.label,
        ...(e.description ? { description: e.description } : {}),
      })),
    });
  }
  return out;
}
