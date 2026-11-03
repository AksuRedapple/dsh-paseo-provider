export interface DshEventLike {
  type: string;
  seq: number;
  time?: number;
  data?: any;
}

export type TurnAction =
  | { type: 'timeline'; event: DshEventLike }
  | { type: 'turn'; state: 'started' | 'completed' | 'failed' | 'canceled'; turn?: number }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'echo'; seq: number }
  | { type: 'echo_timeout'; seq: number }
  | { type: 'reset'; from: number; to: number }
  | { type: 'truncated'; cursor: number }
  | { type: 'unknown'; eventType: string; seq: number }
  | { type: 'reply_started'; turn?: number; step?: number; startedAfterSeq?: number }
  | { type: 'reply_ended'; outcome: any }
  | { type: 'done'; reason: string; detail?: any };

export interface TurnState {
  readonly phase: 'waitEcho' | 'running' | 'done';
  readonly lastSeq: number;
  readonly sawReplyText: boolean;
  readonly echoSeen: boolean;
  onSnapshot(snapshot: { cursor?: number; hasMore?: boolean }): TurnAction[];
  onEvent(ev: DshEventLike): TurnAction[];
  onAssistantFrame(frame: any): TurnAction[];
  onTick(at?: number): TurnAction[];
}

export function createTurnState(opts: {
  promptText?: string;
  startSeq: number;
  now: number;
  echoTimeoutMs?: number;
  budgetMs?: number;
  replyIdleTicks?: number;
  startPhase?: 'waitEcho' | 'running';
  noticeTruncation?: boolean;
}): TurnState;

export function classifyEvent(type: string): 'timeline' | 'turn' | 'ignore' | 'unknown';
export function hasAssistantText(ev: DshEventLike): boolean;
