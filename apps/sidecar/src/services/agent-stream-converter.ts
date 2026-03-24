/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-service.ts
 * Adaptation:
 * - Extracted SDKMessage -> AgentEvent conversion into pure sidecar module.
 * - Removed Electron/webContents concerns; this module is runtime-agnostic.
 */

import type { AgentEvent } from "@lume/shared";
import {
  ToolIndex,
  extractToolResults,
  extractToolStarts,
  type ContentBlock
} from "@lume/shared";

export interface SDKAssistantMessage {
  type: "assistant";
  message: {
    content: Array<{
      type: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      text?: string;
    }>;
    usage?: {
      input_tokens: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  parent_tool_use_id: string | null;
  error?: { message: string; errorType?: string };
  isReplay?: boolean;
}

export interface SDKUserMessage {
  type: "user";
  message?: { content?: unknown[] };
  parent_tool_use_id: string | null;
  tool_use_result?: unknown;
  isReplay?: boolean;
}

export interface SDKStreamEventMessage {
  type: "stream_event";
  event: {
    type: string;
    message?: { id?: string };
    delta?: { type: string; text?: string; stop_reason?: string };
    content_block?: {
      type: string;
      id: string;
      name: string;
      input?: Record<string, unknown>;
    };
  };
  parent_tool_use_id: string | null;
}

export interface SDKResultMessage {
  type: "result";
  subtype: "success" | "error";
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  modelUsage?: Record<string, { contextWindow?: number }>;
  errors?: string[];
}

export interface SDKToolProgressMessage {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds?: number;
}

export interface SDKSystemMessage {
  type: "system";
  subtype?: string;
  status?: string;
  model?: string;
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKStreamEventMessage
  | SDKResultMessage
  | SDKToolProgressMessage
  | SDKSystemMessage
  | { type: string; parent_tool_use_id?: string | null };

export interface AgentStreamConverterState {
  toolIndex: ToolIndex;
  emittedToolStarts: Set<string>;
  activeParentTools: Set<string>;
  pendingText: string | null;
  streamedText: string;
  turnId: string | null;
  cachedContextWindow?: number;
}

export function createAgentStreamConverterState(): AgentStreamConverterState {
  return {
    toolIndex: new ToolIndex(),
    emittedToolStarts: new Set<string>(),
    activeParentTools: new Set<string>(),
    pendingText: null,
    streamedText: "",
    turnId: null,
    cachedContextWindow: undefined
  };
}

function resolveMissingDelta(snapshotText: string, streamedText: string): string {
  if (!snapshotText) return "";
  if (!streamedText) return snapshotText;
  if (snapshotText.startsWith(streamedText)) {
    return snapshotText.slice(streamedText.length);
  }
  // 当 provider 的快照与增量存在漂移时，回退为整段快照，确保不丢内容。
  return snapshotText;
}

export function convertAgentSdkMessage(
  message: SDKMessage,
  state: AgentStreamConverterState
): AgentEvent[] {
  const events: AgentEvent[] = [];

  if (message.type === "assistant") {
    const assistantMessage = message as SDKAssistantMessage;

    if (assistantMessage.error) {
      events.push({ type: "error", message: assistantMessage.error.message || "未知 SDK 错误" });
      return events;
    }

    if (assistantMessage.isReplay) {
      return events;
    }

    if (!assistantMessage.parent_tool_use_id && assistantMessage.message.usage) {
      const usage = assistantMessage.message.usage;
      const inputTokens = usage.input_tokens;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

      events.push({
        type: "usage_update",
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          totalTokens,
          contextWindow: state.cachedContextWindow
        }
      });
    }

    const content = assistantMessage.message.content;
    const textContent = content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");

    const toolStartEvents = extractToolStarts(
      content as ContentBlock[],
      assistantMessage.parent_tool_use_id,
      state.toolIndex,
      state.emittedToolStarts,
      state.turnId ?? undefined,
      state.activeParentTools
    );

    for (const event of toolStartEvents) {
      if (event.type === "tool_start" && event.toolName === "Task") {
        state.activeParentTools.add(event.toolUseId);
      }
    }

    events.push(...toolStartEvents);

    if (textContent) {
      state.pendingText = textContent;
    }

    return events;
  }

  if (message.type === "stream_event") {
    const streamMessage = message as SDKStreamEventMessage;
    const streamEvent = streamMessage.event;

    if (streamEvent.type === "message_start") {
      const messageId = streamEvent.message?.id;
      if (messageId) {
        state.turnId = messageId;
      }
      state.streamedText = "";
    }

    if (streamEvent.type === "message_delta") {
      const stopReason = streamEvent.delta?.stop_reason;
      if (state.pendingText) {
        const missingDelta = resolveMissingDelta(state.pendingText, state.streamedText);
        if (missingDelta) {
          events.push({
            type: "text_delta",
            text: missingDelta,
            turnId: state.turnId ?? undefined,
            parentToolUseId: streamMessage.parent_tool_use_id ?? undefined
          });
        }
        events.push({
          type: "text_complete",
          text: state.pendingText,
          isIntermediate: stopReason === "tool_use",
          turnId: state.turnId ?? undefined,
          parentToolUseId: streamMessage.parent_tool_use_id ?? undefined
        });
        state.pendingText = null;
      }
      state.streamedText = "";
    }

    if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
      state.streamedText += streamEvent.delta.text || "";
      events.push({
        type: "text_delta",
        text: streamEvent.delta.text || "",
        turnId: state.turnId ?? undefined,
        parentToolUseId: streamMessage.parent_tool_use_id ?? undefined
      });
    }

    if (streamEvent.type === "content_block_start" && streamEvent.content_block?.type === "tool_use") {
      const toolBlock = streamEvent.content_block;
      const streamBlocks: ContentBlock[] = [
        {
          type: "tool_use",
          id: toolBlock.id,
          name: toolBlock.name,
          input: (toolBlock.input ?? {}) as Record<string, unknown>
        }
      ];

      const streamToolEvents = extractToolStarts(
        streamBlocks,
        streamMessage.parent_tool_use_id,
        state.toolIndex,
        state.emittedToolStarts,
        state.turnId ?? undefined,
        state.activeParentTools
      );

      for (const event of streamToolEvents) {
        if (event.type === "tool_start" && event.toolName === "Task") {
          state.activeParentTools.add(event.toolUseId);
        }
      }

      events.push(...streamToolEvents);
    }

    return events;
  }

  if (message.type === "user") {
    const userMessage = message as SDKUserMessage;
    if (userMessage.isReplay) {
      return events;
    }

    if (userMessage.tool_use_result !== undefined || userMessage.message) {
      const content = userMessage.message?.content;
      const contentBlocks = (Array.isArray(content) ? content : []) as ContentBlock[];
      const resultEvents = extractToolResults(
        contentBlocks,
        userMessage.parent_tool_use_id,
        userMessage.tool_use_result,
        state.toolIndex,
        state.turnId ?? undefined
      );

      for (const event of resultEvents) {
        if (event.type === "tool_result" && event.toolName === "Task") {
          state.activeParentTools.delete(event.toolUseId);
        }
      }

      events.push(...resultEvents);
    }

    return events;
  }

  if (message.type === "tool_progress") {
    const toolProgress = message as SDKToolProgressMessage;

    if (toolProgress.elapsed_time_seconds !== undefined) {
      events.push({
        type: "task_progress",
        toolUseId: toolProgress.parent_tool_use_id || toolProgress.tool_use_id,
        elapsedSeconds: toolProgress.elapsed_time_seconds,
        turnId: state.turnId ?? undefined
      });
    }

    if (!state.emittedToolStarts.has(toolProgress.tool_use_id)) {
      const progressBlocks: ContentBlock[] = [
        {
          type: "tool_use",
          id: toolProgress.tool_use_id,
          name: toolProgress.tool_name,
          input: {}
        }
      ];

      const progressEvents = extractToolStarts(
        progressBlocks,
        toolProgress.parent_tool_use_id,
        state.toolIndex,
        state.emittedToolStarts,
        state.turnId ?? undefined,
        state.activeParentTools
      );

      for (const event of progressEvents) {
        if (event.type === "tool_start" && event.toolName === "Task") {
          state.activeParentTools.add(event.toolUseId);
        }
      }

      events.push(...progressEvents);
    }

    return events;
  }

  if (message.type === "system") {
    const systemMessage = message as SDKSystemMessage;

    if (systemMessage.subtype === "compact_boundary") {
      events.push({ type: "compact_complete" });
    } else if (systemMessage.subtype === "status" && systemMessage.status === "compacting") {
      events.push({ type: "compacting" });
    }

    return events;
  }

  if (message.type === "result") {
    const resultMessage = message as SDKResultMessage;

    if (state.pendingText) {
      const missingDelta = resolveMissingDelta(state.pendingText, state.streamedText);
      if (missingDelta) {
        events.push({
          type: "text_delta",
          text: missingDelta,
          turnId: state.turnId ?? undefined
        });
      }
      state.pendingText = null;
    }
    state.streamedText = "";

    const primaryModelUsage = Object.values(resultMessage.modelUsage || {})[0];
    if (primaryModelUsage?.contextWindow) {
      state.cachedContextWindow = primaryModelUsage.contextWindow;
    }

    const usage = {
      inputTokens: resultMessage.usage.input_tokens,
      outputTokens: resultMessage.usage.output_tokens,
      cacheReadTokens: resultMessage.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: resultMessage.usage.cache_creation_input_tokens ?? 0,
      totalTokens:
        resultMessage.usage.input_tokens +
        resultMessage.usage.output_tokens +
        (resultMessage.usage.cache_read_input_tokens ?? 0) +
        (resultMessage.usage.cache_creation_input_tokens ?? 0),
      costUsd: resultMessage.total_cost_usd,
      contextWindow: primaryModelUsage?.contextWindow
    };

    if (resultMessage.subtype === "success") {
      events.push({ type: "complete", usage });
    } else {
      const errorMessage = resultMessage.errors ? resultMessage.errors.join(", ") : "Agent 查询失败";
      events.push({ type: "error", message: errorMessage });
      events.push({ type: "complete", usage });
    }

    return events;
  }

  return events;
}
