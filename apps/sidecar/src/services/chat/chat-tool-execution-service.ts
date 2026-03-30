// TODO: 长期考虑统一 Chat/Agent tool 体系到 Pi SDK tool 抽象
/**
 * Extracted from chat-send-service.ts to keep tool execution boundaries isolated.
 * Covers both preflight tool runs and model tool-call execution.
 */

import { randomUUID } from "node:crypto";
import type { ChatToolActivity, ChatMessage, ChatToolMeta, FileAttachment } from "@lume/shared";
import type { ToolCall, ToolResult } from "../../providers";
import { ensureDefaultWorkspace } from "../agent/agent-workspace-manager";
import { searchWorkspaceMemory } from "../memory/memory-service";
import {
  buildAgentModeRecommendation,
  shouldSuggestAgentMode
} from "./chat-agent-recommendation-service";
import {
  buildNanoBananaEnhancedPrompt,
  inferNanoBananaAspectRatio,
  inferNanoBananaImageSize,
  shouldRunNanoBananaForChat,
  shouldUseReferenceImagesForNanoBanana
} from "./chat-nano-banana-prompt-service";
import {
  getAllChatToolInfos,
  getChatToolCredentials
} from "./chat-tool-manager";
import { executeHttpChatTool } from "./chat-tool-http-executor";
import { generateNanoBananaImage } from "./nano-banana-service";
import {
  searchWeb,
  shouldRunWebSearch
} from "./chat-web-search-service";

function runCustomHttpTool(meta: ChatToolMeta, userMessage: string): Promise<string> {
  return executeHttpChatTool(meta, {
    userMessage,
    credentials: getChatToolCredentials(meta.id)
  });
}

function getStringArgument(argumentsObj: Record<string, unknown>, key: string): string | undefined {
  const value = argumentsObj[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getBooleanArgument(argumentsObj: Record<string, unknown>, key: string): boolean | undefined {
  const value = argumentsObj[key];
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function getLatestAttachmentsByRole(
  history: ChatMessage[],
  role: "user" | "assistant"
): FileAttachment[] | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (!item) continue;
    if (item.role !== role) continue;
    if (item.attachments && item.attachments.length > 0) {
      return item.attachments;
    }
  }
  return undefined;
}

export async function executeToolCallForChat(input: {
  conversationId: string;
  messageHistory: ChatMessage[];
  toolCall: ToolCall;
  fallbackQuery: string;
  enabledMetaMap: Map<string, ChatToolMeta>;
  currentAttachments?: FileAttachment[];
  previousUserAttachments?: FileAttachment[];
  previousAssistantAttachments?: FileAttachment[];
  emitToolActivity: (activity: ChatToolActivity) => void;
}): Promise<ToolResult> {
  const { toolCall, fallbackQuery, enabledMetaMap } = input;
  const meta = enabledMetaMap.get(toolCall.name);
  if (!meta) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: `工具未启用或不存在: ${toolCall.name}`,
      isError: true
    };
  }

  input.emitToolActivity({
    type: "start",
    toolName: toolCall.name,
    toolCallId: toolCall.id
  });

  const query = getStringArgument(toolCall.arguments, "query")
    ?? getStringArgument(toolCall.arguments, "message")
    ?? fallbackQuery;

  try {
    if (toolCall.name === "memory_search") {
      const workspace = ensureDefaultWorkspace();
      const results = await searchWorkspaceMemory({
        workspaceSlug: workspace.slug,
        query,
        maxResults: 5
      });
      const text = results.length === 0
        ? "未检索到相关记忆。"
        : results.map((item, index) => `${index + 1}. [${item.path}] ${item.snippet}`.trim()).join("\n\n");
      input.emitToolActivity({
        type: "result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result: text
      });
      return { toolCallId: toolCall.id, toolName: toolCall.name, content: text };
    }

    if (toolCall.name === "web_search") {
      const { provider, result } = await searchWeb(query, getChatToolCredentials("web_search"));
      const text = `[provider=${provider}]\n${result}`;
      input.emitToolActivity({
        type: "result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result: text
      });
      return { toolCallId: toolCall.id, toolName: toolCall.name, content: text };
    }

    if (toolCall.name === "suggest_agent_mode") {
      const reason = getStringArgument(toolCall.arguments, "reason");
      const suggestedPrompt = getStringArgument(toolCall.arguments, "suggestedPrompt");
      const recommendation = (reason && suggestedPrompt)
        ? { reason, suggestedPrompt }
        : buildAgentModeRecommendation(fallbackQuery);
      const text = JSON.stringify({
        type: "agent_recommendation",
        ...recommendation
      });
      input.emitToolActivity({
        type: "result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result: text
      });
      return { toolCallId: toolCall.id, content: text };
    }

    if (toolCall.name === "nano_banana") {
      const prompt = getStringArgument(toolCall.arguments, "prompt") ?? query;
      const aspectRatio = getStringArgument(toolCall.arguments, "aspectRatio")
        ?? inferNanoBananaAspectRatio(prompt);
      const imageSize = getStringArgument(toolCall.arguments, "imageSize")
        ?? inferNanoBananaImageSize(prompt);
      const useReferenceImages = getBooleanArgument(toolCall.arguments, "useReferenceImages")
        ?? shouldUseReferenceImagesForNanoBanana({
          userMessage: prompt,
          currentAttachments: input.currentAttachments,
          previousUserAttachments: input.previousUserAttachments,
          previousAssistantAttachments: input.previousAssistantAttachments
        });
      const result = await generateNanoBananaImage(
        {
          conversationId: input.conversationId,
          prompt: buildNanoBananaEnhancedPrompt(prompt, {
            messageHistory: input.messageHistory,
            useReferenceImages
          }),
          aspectRatio,
          imageSize,
          useReferenceImages,
          currentAttachments: input.currentAttachments,
          previousUserAttachments: input.previousUserAttachments,
          previousAssistantAttachments: input.previousAssistantAttachments
        },
        getChatToolCredentials("nano_banana")
      );
      input.emitToolActivity({
        type: "result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result: result.text
      });
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.text,
        generatedAttachments: result.attachments
      };
    }

    if (meta.category === "custom") {
      const customQuery = query || JSON.stringify(toolCall.arguments);
      const result = await runCustomHttpTool(meta, customQuery);
      input.emitToolActivity({
        type: "result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result
      });
      return { toolCallId: toolCall.id, toolName: toolCall.name, content: result };
    }

    const message = `暂不支持的工具: ${toolCall.name}`;
    input.emitToolActivity({
      type: "result",
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      result: message,
      isError: true
    });
    return { toolCallId: toolCall.id, toolName: toolCall.name, content: message, isError: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.emitToolActivity({
      type: "result",
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      result: message,
      isError: true
    });
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: message,
      isError: true
    };
  }
}

export async function runEnabledToolsForChat(input: {
  conversationId: string;
  userMessage: string;
  messageHistory: ChatMessage[];
  attachments?: FileAttachment[];
  previousUserAttachments?: FileAttachment[];
  previousAssistantAttachments?: FileAttachment[];
  enabledToolIds?: string[];
  emitToolActivity: (activity: ChatToolActivity) => void;
}): Promise<{ contextAppendix?: string; generatedAttachments: FileAttachment[] }> {
  const toolInfos = getAllChatToolInfos();
  const enabledAndAvailable = new Set(
    toolInfos
      .filter((tool) => tool.enabled && tool.available)
      .map((tool) => tool.meta.id)
  );
  const requested = input.enabledToolIds
    ? new Set((input.enabledToolIds ?? []).filter((item) => typeof item === "string"))
    : enabledAndAvailable;
  const enabled = new Set(
    Array.from(requested).filter((toolId) => enabledAndAvailable.has(toolId))
  );
  const contextSections: string[] = [];
  const generatedAttachments: FileAttachment[] = [];

  if (enabled.has("memory_search")) {
    const toolCallId = randomUUID();
    input.emitToolActivity({ type: "start", toolName: "memory_search", toolCallId });
    try {
      const workspace = ensureDefaultWorkspace();
      const results = await searchWorkspaceMemory({
        workspaceSlug: workspace.slug,
        query: input.userMessage,
        maxResults: 5
      });
      const text = results.length === 0
        ? "未检索到相关记忆。"
        : results.map((item, index) => `${index + 1}. [${item.path}] ${item.snippet}`.trim()).join("\n\n");
      contextSections.push(`memory_search:\n${text}`);
      input.emitToolActivity({ type: "result", toolName: "memory_search", toolCallId, result: text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emitToolActivity({ type: "result", toolName: "memory_search", toolCallId, result: message, isError: true });
    }
  }

  if (enabled.has("suggest_agent_mode") && shouldSuggestAgentMode(input.userMessage)) {
    const toolCallId = randomUUID();
    input.emitToolActivity({ type: "start", toolName: "suggest_agent_mode", toolCallId });
    try {
      const result = JSON.stringify({
        type: "agent_recommendation",
        ...buildAgentModeRecommendation(input.userMessage)
      });
      contextSections.push(`suggest_agent_mode:\n${result}`);
      input.emitToolActivity({ type: "result", toolName: "suggest_agent_mode", toolCallId, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emitToolActivity({ type: "result", toolName: "suggest_agent_mode", toolCallId, result: message, isError: true });
    }
  }

  if (enabled.has("web_search") && shouldRunWebSearch(input.userMessage)) {
    const toolCallId = randomUUID();
    input.emitToolActivity({ type: "start", toolName: "web_search", toolCallId });
    try {
      const { provider, result } = await searchWeb(input.userMessage, getChatToolCredentials("web_search"));
      contextSections.push(`web_search(${provider}):\n${result}`);
      input.emitToolActivity({ type: "result", toolName: "web_search", toolCallId, result: `[provider=${provider}]\n${result}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emitToolActivity({ type: "result", toolName: "web_search", toolCallId, result: message, isError: true });
    }
  }

  if (enabled.has("nano_banana") && shouldRunNanoBananaForChat(input.userMessage, input.attachments)) {
    const toolCallId = randomUUID();
    input.emitToolActivity({ type: "start", toolName: "nano_banana", toolCallId });
    try {
      const useReferenceImages = shouldUseReferenceImagesForNanoBanana({
        userMessage: input.userMessage,
        currentAttachments: input.attachments,
        previousUserAttachments: input.previousUserAttachments,
        previousAssistantAttachments: input.previousAssistantAttachments
      });
      const result = await generateNanoBananaImage(
        {
          conversationId: input.conversationId,
          prompt: buildNanoBananaEnhancedPrompt(input.userMessage, {
            messageHistory: input.messageHistory,
            useReferenceImages
          }),
          aspectRatio: inferNanoBananaAspectRatio(input.userMessage),
          imageSize: inferNanoBananaImageSize(input.userMessage),
          useReferenceImages,
          currentAttachments: input.attachments,
          previousUserAttachments: input.previousUserAttachments,
          previousAssistantAttachments: input.previousAssistantAttachments
        },
        getChatToolCredentials("nano_banana")
      );
      contextSections.push(`nano_banana:\n${result.text}`);
      if (result.attachments?.length) {
        generatedAttachments.push(...result.attachments);
      }
      input.emitToolActivity({ type: "result", toolName: "nano_banana", toolCallId, result: result.text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emitToolActivity({ type: "result", toolName: "nano_banana", toolCallId, result: message, isError: true });
    }
  }

  const customEnabledTools = toolInfos.filter(
    (tool) =>
      tool.meta.category === "custom" &&
      tool.enabled &&
      tool.available &&
      enabled.has(tool.meta.id)
  );

  for (const tool of customEnabledTools) {
    const toolCallId = randomUUID();
    input.emitToolActivity({ type: "start", toolName: tool.meta.id, toolCallId });
    try {
      const result = await runCustomHttpTool(tool.meta, input.userMessage);
      contextSections.push(`${tool.meta.id}:\n${result}`);
      input.emitToolActivity({ type: "result", toolName: tool.meta.id, toolCallId, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emitToolActivity({ type: "result", toolName: tool.meta.id, toolCallId, result: message, isError: true });
    }
  }

  return {
    contextAppendix: contextSections.length > 0
      ? ["以下是本轮工具执行结果，可作为回答参考：", ...contextSections].join("\n\n")
      : undefined,
    generatedAttachments
  };
}
