import type { AgentMessage } from "@lume/shared"
import { isCompactionSdkMessage } from "@lume/shared"

/**
 * 传输裁剪：把 message.sdkMessages 仅保留 compaction system 消息（前端打开会话时唯一所需），
 * 其余 assistant/user/result 原始交换丢弃。在 GET_THREAD_MESSAGES RPC 响应边界套用。
 * 内部 getVisibleAgentMessages 不受影响（engine 重建上下文仍用全量）。
 */
export function trimSdkMessagesForTransport(message: AgentMessage): AgentMessage {
  const sdk = message.sdkMessages
  if (!sdk || sdk.length === 0) return message
  const compactionOnly = sdk.filter(isCompactionSdkMessage)
  if (compactionOnly.length === sdk.length) return message
  return { ...message, sdkMessages: compactionOnly.length > 0 ? compactionOnly : undefined }
}
