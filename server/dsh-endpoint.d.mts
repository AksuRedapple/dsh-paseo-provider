export interface DshEndpoint {
  base: string;
  mux: string;
  cookie?: string;
  source: 'env' | 'discovered' | 'discovered-no-cookie' | 'legacy-fallback';
  logPath?: string;
}

export interface DshEndpointOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  home?: string;
  logPath?: string;
  fetchImpl?: typeof fetch;
  exchangeTimeoutMs?: number;
  force?: boolean;
}

export function parseWebLog(text: string): { token: string; port: number } | null;
export function defaultWebLogPath(opts?: { platform?: string; home?: string; env?: Record<string, string | undefined> }): string;
export function exchangeToken(opts: {
  base: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string | undefined>;
export function resolveDshEndpoint(opts?: DshEndpointOptions): Promise<DshEndpoint>;
export function getDshEndpoint(opts?: DshEndpointOptions): Promise<DshEndpoint>;
export function clearDshEndpointCache(): void;
