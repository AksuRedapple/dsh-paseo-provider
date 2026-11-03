export interface DshEvent {
  type: string;
  seq: number;
  time: number;
  data: any;
}

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: any }) => void) | null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null;
  onerror: ((e: any) => void) | null;
  send(data: string): void;
  close(): void;
}

export type FollowMessage =
  | { kind: 'snapshot'; cursor: number; hasMore: boolean; events: DshEvent[] }
  | { kind: 'event'; event: DshEvent }
  | { kind: 'assistant'; frame: any }
  | { kind: 'unknown'; valueType: string }
  | { kind: 'reset'; from: number; to: number }
  | { kind: 'gap'; from: number; to: number }
  | { kind: 'truncated'; cursor: number }
  | { kind: 'error'; error: unknown; reconnecting: boolean };

export interface FollowOptions {
  url?: string;
  headers?: Record<string, string>;
  maxMessages?: number;
  assistantStream?: boolean;
  reconnect?: boolean;
  backoffMs?: number[];
  readyTimeoutMs?: number;
  connect?: (url: string) => SocketLike;
}

export interface FollowHandle extends AsyncIterable<FollowMessage> {
  ready: Promise<{ cursor: number; hasMore: boolean; events: DshEvent[] }>;
  close(): void;
}

export function followSession(sessionId: string, opts?: FollowOptions): FollowHandle;
export function readSnapshot(
  sessionId: string,
  timeoutMs?: number,
): Promise<{ cursor: number; hasMore: boolean; events: DshEvent[] }>;
