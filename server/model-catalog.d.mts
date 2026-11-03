export interface ModelRef {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ProviderThinkingOptionLike {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface ProviderModelLike {
  id: string;
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
  thinkingOptions?: ProviderThinkingOptionLike[];
  defaultThinkingOptionId?: string;
}

export interface ProviderConfigStateLike {
  model?: string;
  mode?: string;
  thinkingOption?: string;
  models: ProviderModelLike[];
  modes: Array<{ id: string; label: string }>;
  thinkingOptions: ProviderThinkingOptionLike[];
  settings: unknown[];
}

export const MODEL_SEP: string;
export function encodeModelId(provider: string, model: string): string;
export function parseModelId(id: unknown): { provider: string; model: string } | null;
export function catalogModels(cat: unknown): ProviderModelLike[];
export function catalogDefaults(cat: unknown): {
  models: ProviderModelLike[];
  defaultModel?: string;
  defaultThinkingOption?: string;
};
export function findCatalogModel(
  cat: unknown,
  provider: string,
  model: string,
): { provider: string; providerName: string; model: any } | null;
export function thinkingOptionsFor(cat: unknown, ref: ModelRef | null | undefined): ProviderThinkingOptionLike[];
export function sessionModelRef(item: unknown): ModelRef | null;
export function contextWindowOf(item: unknown): number | undefined;
export function toProviderConfig(cat: unknown, current: ModelRef | null | undefined): ProviderConfigStateLike;
export function acpConfigOptions(cat: unknown, current: ModelRef | null | undefined): any[];
