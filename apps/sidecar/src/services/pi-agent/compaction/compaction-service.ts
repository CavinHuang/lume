/**
 * Compaction 适配服务
 *
 * 将 Lume 的 AgentMessage[] 转换为上游 pi-coding-agent 期望的格式，
 * 使用已导出的上游纯函数完成 LLM 摘要压缩。
 *
 * 策略：用 estimateTokens 估算 token，用 findCutPoint 找切割点，
 * 用 generateSummary 生成 LLM 摘要。
 */

import type { AgentMessage as LumeAgentMessage } from "@lume/shared";
import type { AgentMessage as PiAgentMessage } from "@mariozechner/pi-agent-core";
import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ToolCall,
  Model,
  Api
} from "@mariozechner/pi-ai";
import type {
  SessionEntry,
  SessionMessageEntry,
  CompactionEntry,
  CompactionResult
} from "@mariozechner/pi-coding-agent";
import {
  shouldCompact as upstreamShouldCompact,
  estimateTokens,
  findCutPoint,
  generateSummary
} from "@mariozechner/pi-coding-agent";
import { getStoredCompaction } from "./compaction-store";

// 复用上游 CompactionSettings 结构（手动定义，因为主入口导出的版本字段可选）
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

// ---------------------------------------------------------------------------
// Lume → Pi 消息格式转换
// ---------------------------------------------------------------------------

/**
 * 从 Lume assistant 消息的 events 中重建上游 ToolCall + ToolResult 结构。
 */
function rebuildToolCallsFromEvents(
  lumeMsg: LumeAgentMessage
): { toolCalls: ToolCall[]; toolResults: ToolResultMessage[] } {
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResultMessage[] = [];

  if (!lumeMsg.events?.length) {
    return { toolCalls, toolResults };
  }

  for (const event of lumeMsg.events) {
    if (event.type === "tool_start") {
      toolCalls.push({
        type: "toolCall",
        id: event.toolUseId ?? `call_${toolCalls.length}`,
        name: event.toolName ?? "unknown",
        arguments: (event.input as Record<string, unknown>) ?? {}
      });
    } else if (event.type === "tool_result") {
      const resultText = typeof event.result === "string"
        ? event.result
        : JSON.stringify(event.result ?? "");
      const truncated = resultText.length > 2000
        ? resultText.slice(0, 2000) + "…[truncated]"
        : resultText;

      toolResults.push({
        role: "toolResult",
        toolCallId: event.toolUseId ?? `call_${toolResults.length}`,
        toolName: event.toolName ?? "unknown",
        content: [{ type: "text", text: truncated }],
        isError: event.isError ?? false,
        timestamp: lumeMsg.createdAt
      });
    }
  }

  return { toolCalls, toolResults };
}

/**
 * 将单条 Lume 消息转换为上游 PiAgentMessage。
 */
function convertLumeMessageToPiMessages(lumeMsg: LumeAgentMessage): PiAgentMessage[] {
  if (lumeMsg.role === "user") {
    const userMsg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: lumeMsg.content }],
      timestamp: lumeMsg.createdAt
    };
    return [userMsg];
  }

  if (lumeMsg.role === "assistant") {
    const { toolCalls, toolResults } = rebuildToolCallsFromEvents(lumeMsg);

    const contentBlocks: (TextContent | ToolCall)[] = [];
    if (lumeMsg.content) {
      contentBlocks.push({ type: "text", text: lumeMsg.content });
    }
    contentBlocks.push(...toolCalls);

    if (contentBlocks.length === 0) {
      contentBlocks.push({ type: "text", text: "" });
    }

    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: contentBlocks,
      api: "anthropic-messages",
      provider: "anthropic",
      model: lumeMsg.model ?? "unknown",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: lumeMsg.createdAt
    };

    const result: PiAgentMessage[] = [assistantMsg];
    for (const tr of toolResults) {
      result.push(tr);
    }
    return result;
  }

  return [];
}

/**
 * 将 Lume AgentMessage[] 转换为上游 SessionEntry[]。
 */
export function convertToSessionEntries(
  messages: LumeAgentMessage[],
  sessionId?: string
): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let prevId: string | null = null;

  const stored = sessionId ? getStoredCompaction(sessionId) : null;
  if (stored) {
    const compactionEntry: CompactionEntry = {
      type: "compaction",
      id: `compaction_${Date.now()}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: stored.summary,
      firstKeptEntryId: stored.firstKeptEntryId,
      tokensBefore: stored.tokensBefore,
      details: stored.details
    };
    entries.push(compactionEntry);
    prevId = compactionEntry.id;
  }

  for (const lumeMsg of messages) {
    const piMessages = convertLumeMessageToPiMessages(lumeMsg);
    for (const piMsg of piMessages) {
      const entryId = `${lumeMsg.id}_${entries.length}`;
      const entry: SessionMessageEntry = {
        type: "message",
        id: entryId,
        parentId: prevId,
        timestamp: new Date(lumeMsg.createdAt).toISOString(),
        message: piMsg
      };
      entries.push(entry);
      prevId = entryId;
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Token 估算
// ---------------------------------------------------------------------------

/**
 * 从 Lume 消息列表估算当前上下文 token 数。
 * 使用上游的 estimateTokens (chars/4 启发式) 逐条累加。
 */
export function estimateContextTokensFromLumeMessages(
  messages: LumeAgentMessage[],
  sessionId?: string
): number {
  const entries = convertToSessionEntries(messages, sessionId);
  let total = 0;
  for (const entry of entries) {
    if (entry.type === "message") {
      total += estimateTokens(entry.message);
    } else if (entry.type === "compaction") {
      // 压缩摘要本身也占 token
      total += Math.ceil(entry.summary.length / 4);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// 执行压缩
// ---------------------------------------------------------------------------

export interface RunCompactionParams {
  sessionId: string;
  messages: LumeAgentMessage[];
  model: Model<Api>;
  apiKey: string;
  settings: CompactionSettings;
  customInstructions?: string;
  signal?: AbortSignal;
}

/**
 * 执行 LLM 摘要压缩。
 *
 * 流程：
 * 1. 转换为 SessionEntry[]
 * 2. 用 findCutPoint 找切割点（保留 keepRecentTokens 的近期消息）
 * 3. 提取待摘要的消息
 * 4. 调用 generateSummary 生成 LLM 摘要
 * 5. 返回 CompactionResult
 */
export async function runCompaction(
  params: RunCompactionParams
): Promise<CompactionResult | null> {
  const { sessionId, messages, model, apiKey, settings, customInstructions, signal } = params;

  const entries = convertToSessionEntries(messages, sessionId);
  if (entries.length < 2) {
    return null;
  }

  // 找到已有 compaction entry 的索引作为起始点
  let startIndex = 0;
  let previousSummary: string | undefined;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry && entry.type === "compaction") {
      startIndex = i + 1;
      previousSummary = entry.summary;
    }
  }

  const endIndex = entries.length;
  if (startIndex >= endIndex) {
    return null;
  }

  // 使用上游 findCutPoint 找切割点
  const cutResult = findCutPoint(entries, startIndex, endIndex, settings.keepRecentTokens);
  if (cutResult.firstKeptEntryIndex <= startIndex) {
    console.log(`[Compaction] session=${sessionId} 切割点在起始位置，无需压缩`);
    return null;
  }

  const firstKeptEntry = entries[cutResult.firstKeptEntryIndex];
  if (!firstKeptEntry) {
    return null;
  }
  const firstKeptEntryId = firstKeptEntry.id;

  // 提取待摘要的消息（从 startIndex 到切割点之间的 message entries）
  const messagesToSummarize: PiAgentMessage[] = [];
  for (let i = startIndex; i < cutResult.firstKeptEntryIndex; i++) {
    const entry = entries[i];
    if (entry && entry.type === "message") {
      messagesToSummarize.push(entry.message);
    }
  }

  if (messagesToSummarize.length === 0) {
    return null;
  }

  // 估算压缩前 token 数
  let tokensBefore = 0;
  for (const entry of entries) {
    if (entry.type === "message") {
      tokensBefore += estimateTokens(entry.message);
    }
  }

  console.log(
    `[Compaction] session=${sessionId} 开始 LLM 摘要生成（待压缩消息数=${messagesToSummarize.length}, tokensBefore=${tokensBefore}）`
  );

  try {
    const summary = await generateSummary(
      messagesToSummarize,
      model,
      settings.reserveTokens,
      apiKey,
      signal,
      customInstructions,
      previousSummary
    );

    console.log(
      `[Compaction] session=${sessionId} 摘要生成完成（摘要长度=${summary.length}）`
    );

    return {
      summary,
      firstKeptEntryId,
      tokensBefore
    };
  } catch (error) {
    console.error(`[Compaction] session=${sessionId} 摘要生成失败:`, error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// shouldCompact 重导出
// ---------------------------------------------------------------------------

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings
): boolean {
  return upstreamShouldCompact(contextTokens, contextWindow, settings);
}

// ---------------------------------------------------------------------------
// 构建压缩后的上下文
// ---------------------------------------------------------------------------

function formatLumeMessage(message: LumeAgentMessage): string {
  if (message.role === "user") return `[user]: ${message.content}`;
  if (message.role !== "assistant") return "";

  const parts: string[] = [];
  if (message.content) parts.push(message.content);

  if (message.events?.length) {
    const toolSummaries: string[] = [];
    for (const event of message.events) {
      if (event.type === "tool_start") {
        toolSummaries.push(`[tool: ${event.toolName}(${JSON.stringify(event.input ?? {})})]`);
      } else if (event.type === "tool_result") {
        const resultText = typeof event.result === "string"
          ? event.result.slice(0, 500)
          : JSON.stringify(event.result ?? "").slice(0, 500);
        toolSummaries.push(`[tool_result: ${resultText}]`);
      }
    }
    if (toolSummaries.length > 0) {
      parts.push(toolSummaries.join("\n"));
    }
  }

  return `[assistant]: ${parts.join("\n")}`;
}

export interface BuildCompactedContextParams {
  sessionId: string;
  currentUserMessage: string;
  allMessages: LumeAgentMessage[];
}

/**
 * 构建压缩后的上下文提示词。
 * 有摘要时：<compaction_summary> + 保留的近期消息 + 当前消息
 * 无摘要时：完整历史 + 当前消息
 */
export function buildCompactedContextPrompt(
  params: BuildCompactedContextParams
): { text: string; compacted: boolean } {
  const { sessionId, currentUserMessage, allMessages } = params;

  if (allMessages.length === 0) {
    return { text: currentUserMessage, compacted: false };
  }

  const history = allMessages.slice(0, -1);
  if (history.length === 0) {
    return { text: currentUserMessage, compacted: false };
  }

  const stored = getStoredCompaction(sessionId);
  if (!stored) {
    const lines = history
      .filter((msg) => (msg.role === "user" || msg.role === "assistant") && msg.content)
      .map((msg) => formatLumeMessage(msg))
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return { text: currentUserMessage, compacted: false };
    }

    return {
      text: `<conversation_history>\n${lines.join("\n")}\n</conversation_history>\n\n${currentUserMessage}`,
      compacted: false
    };
  }

  // 有压缩记录：摘要 + 保留的近期消息
  const keptEntryId = stored.firstKeptEntryId;

  // firstKeptEntryId 格式为 "{lumeMsg.id}_{entryIndex}"，提取原始消息 ID
  const keptLumeMsgId = keptEntryId.includes("_")
    ? keptEntryId.substring(0, keptEntryId.lastIndexOf("_"))
    : keptEntryId;

  let keptFromIndex = history.findIndex((msg) => msg.id === keptLumeMsgId);
  if (keptFromIndex === -1) {
    keptFromIndex = Math.max(0, Math.floor(history.length / 2));
  }

  const keptMessages = history.slice(keptFromIndex);
  const keptLines = keptMessages
    .filter((msg) => (msg.role === "user" || msg.role === "assistant") && msg.content)
    .map((msg) => formatLumeMessage(msg))
    .filter((line) => line.length > 0);

  const parts: string[] = [];
  parts.push(`<compaction_summary>\n${stored.summary}\n</compaction_summary>`);

  if (keptLines.length > 0) {
    parts.push(`<conversation_history>\n${keptLines.join("\n")}\n</conversation_history>`);
  }

  parts.push(currentUserMessage);

  return {
    text: parts.join("\n\n"),
    compacted: true
  };
}
