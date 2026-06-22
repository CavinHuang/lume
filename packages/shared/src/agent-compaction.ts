import type { SDKMessage } from "./types/agent"

/** compaction system 消息的 SDK 子类型——打开会话时前端唯一需要的 sdkMessages 子集。 */
const COMPACTION_SYSTEM_SUBTYPES = new Set([
  "context_compaction_started",
  "context_compaction_progress",
  "compact_boundary",
])

/** 判断一条 SDKMessage 是否为 compaction system 消息。 */
export function isCompactionSdkMessage(message: SDKMessage): boolean {
  return message.type === "system" && COMPACTION_SYSTEM_SUBTYPES.has(message.subtype)
}
