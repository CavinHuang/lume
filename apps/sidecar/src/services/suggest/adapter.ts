/**
 * 对话文本 adapter — 从 thread transcript 抽取最近 user 消息供建议引擎评估。
 *
 * 读取路径：`getAgentThreadMessages(threadId)`（agent-thread-manager.ts:327），
 * 该函数已把 runtime-core transcript / 版本存储投影为 AgentMessage[]，
 * 其中 content 字段是 extractRenderableAssistantText 提取后的纯文本
 * （tool_use / tool_result / thinking / image 块在投影层已被剥离）。
 * 因此本 adapter 只需按 role === "user" 过滤、对 content 做切片，
 * 不再重复解析 sdkMessages 原始块。
 *
 * fail-open：读取异常或线程不存在时返回 []，绝不抛错——建议引擎把缺失
 * 上下文视为"无信号"，而不是一次运行失败。
 *
 * Task 9 service 将本函数输出直接喂给 evaluateSuggestions（形状与
 * signals.UserMessage 一致：{role:"user"; content:string}[]）。
 */
import type { AgentMessage } from "@lume/shared";
import { getAgentThreadMessages } from "../agent/agent-thread-manager";
import { createLogger } from "../infra/logger";

const log = createLogger("suggest-adapter");

/** 默认回溯的 user 消息条数（brief 契约） */
const DEFAULT_LIMIT = 30;
/** 单条 user 消息 content 切片上限（brief 契约） */
const MAX_CONTENT_SLICE = 800;

export interface ExtractConversationInput {
  /** 目标线程 ID（必需） */
  threadId: string;
  /**
   * 工作区 slug。当前 read path 仅依赖 threadId（线程索引全局唯一），
   * 此字段为 Task 9 service 上下文对称保留，暂不参与读取。
   */
  workspaceSlug?: string;
  /** 回溯条数，默认 30 */
  limit?: number;
}

/** adapter 输出条目（与 signals.UserMessage 同形） */
export type ConversationUserMessage = { role: "user"; content: string };

/**
 * 抽取指定线程最近的 user 消息（纯文本）。
 *
 * @returns 按时间正序的 user 消息数组；线程为空或读取失败时返回 []
 */
export async function extractRecentConversation(
  input: ExtractConversationInput,
): Promise<ConversationUserMessage[]> {
  const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
  if (!threadId) return [];

  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
      ? Math.floor(input.limit)
      : DEFAULT_LIMIT;

  let messages: AgentMessage[];
  try {
    messages = getAgentThreadMessages(threadId);
  } catch (error) {
    log.warn("failed to read thread messages", { threadId, error });
    return [];
  }

  const userMessages: ConversationUserMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const raw = typeof msg.content === "string" ? msg.content : "";
    if (!raw.trim()) continue;
    userMessages.push({ role: "user", content: raw.slice(0, MAX_CONTENT_SLICE) });
  }

  // 取最后 `limit` 条 user 消息（chronological tail）
  return userMessages.slice(-limit);
}
