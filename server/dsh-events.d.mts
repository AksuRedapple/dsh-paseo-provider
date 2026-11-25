import type { SocketLike } from './dsh-follow.mjs';

/** 一条 `$events` waterfall 帧（要客户端作答的那种）。 */
export interface HostWaterfallFrame {
  /** 该帧所属 `$events` 流的 clientId —— 回包必须带上它（重连会变）。 */
  clientId: string;
  /** Cordis 事件名，目前只消费 `user-questions/request`。 */
  event: string;
  eventId: string;
  /** Agent 身份；DSH 的 wire 类型就是 SessionId。 */
  agentId: string;
  /** 事件本身的可 JSON 字段（提问在 `request.questions`）。 */
  request: any;
}

export interface HostEventOptions {
  url?: string;
  connect?: (url: string) => SocketLike;
  onFrame?: (frame: HostWaterfallFrame) => void;
  onReady?: (info: { clientId: string | null }) => void;
  /** 其它帧（`emit` 广播等），排障用。 */
  onOther?: (value: any) => void;
  /** 重连前重新解析端点（DSH 重启会换 cookie / 端口）；返回空则沿用旧端点。 */
  resolveEndpoint?: () => Promise<{ url?: string; connect?: (url: string) => SocketLike } | null | undefined>;
  backoffMs?: number[];
  reconnect?: boolean;
}

export interface HostEventHandle {
  ready: Promise<{ clientId: string | null }>;
  clientId(): string | null;
  close(): void;
}

export function subscribeHostEvents(opts?: HostEventOptions): HostEventHandle;
