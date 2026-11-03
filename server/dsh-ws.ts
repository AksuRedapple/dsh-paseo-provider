/**
 * DSH mux 客户端（TS 包装层）
 *
 * 实现在 `dsh-follow.mjs`（普通 ESM）；
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

/** 拉某个会话的完整历史快照（records + hasMore/cursor）。超时返回空快照，绝不抛。 */
export async function fetchSessionSnapshot(
  sessionId: string,
  timeoutMs = 15000,
): Promise<{ cursor: number; hasMore: boolean; events: DshEvent[] }> {
  return readSnapshot(sessionId, timeoutMs);
}

/** 只取 records（不关心截断标志的调用方用）。 */
export async function fetchSessionRecords(sessionId: string, timeoutMs = 15000): Promise<DshEvent[]> {
  const snap = await fetchSessionSnapshot(sessionId, timeoutMs);
  return snap.events;
}
