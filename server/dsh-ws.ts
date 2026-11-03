/**
 * DSH mux 客户端（TS 包装层）
 *
 * 实现在 `dsh-follow.mjs`（普通 ESM，供 ACP server 共用）；
 * 本文件只保留类型与一次性读取的契约。
 */
export type {
  DshEvent,
  SocketLike,
  FollowMessage,
  FollowOptions,
  FollowHandle,
} from './dsh-follow.mjs';

export { followSession, readSnapshot } from './dsh-follow.mjs';

import { readSnapshot } from './dsh-follow.mjs';
import type { DshEvent } from './dsh-follow.mjs';

/** 拉某个会话的完整历史快照（records）。超时返回空数组，绝不抛。 */
export async function fetchSessionRecords(sessionId: string, timeoutMs = 15000): Promise<DshEvent[]> {
  const snap = await readSnapshot(sessionId, timeoutMs);
  return snap.events;
}
