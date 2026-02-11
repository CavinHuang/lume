/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-service.ts
 * Adaptation:
 * - Replaced SDK runtime with provider-adapter streaming for fast MVP.
 * - Kept Agent event protocol and session persistence contract.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentGenerateTitleInput,
  AgentMessage,
  AgentSendInput,
  ChatMessage
} from "@lume/shared";
import { fetchTitle, getAdapter, streamSSE } from "../providers";
import { decryptApiKey, listChannels } from "./channel-manager";
import {
  appendAgentMessage,
  getAgentSessionMeta,
  getAgentSessionMessages,
  updateAgentSessionMeta
} from "./agent-session-manager";
import {
  appendAgentEvents,
  buildAssistantAgentMessage,
  createAgentStreamAccumulatorState
} from "./agent-stream-accumulator";

type AgentEventEmitter = {
  onEvent: (event: AgentEvent) => void;
  onComplete: () => void;
  onError: (error: string) => void;
  onTitleUpdated: (title: string) => void;
};

const activeControllers = new Map<string, AbortController>();

const AGENT_TITLE_PROMPT =
  "根据用户的第一条消息，生成一个简短的会话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：";
const MAX_TITLE_LENGTH = 20;
const DEFAULT_AGENT_TITLE = "新 Agent 会话";

function pickModelId(channelId: string, requestedModelId?: string): string {
  if (requestedModelId) return requestedModelId;
  const channel = listChannels().find((item) => item.id === channelId);
  const enabledModel = channel?.models.find((model) => model.enabled);
  if (enabledModel) return enabledModel.id;
  return channel?.models[0]?.id ?? "claude-sonnet-4-5-20250929";
}

function buildHistoryForAdapter(messages: AgentMessage[]): ChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
      createdAt: message.createdAt,
      model: message.model
    }));
}

export async function sendAgentMessage(input: AgentSendInput, emit: AgentEventEmitter): Promise<void> {
  const { sessionId, userMessage, channelId } = input;

  const channel = listChannels().find((item) => item.id === channelId);
  if (!channel) {
    emit.onError("渠道不存在");
    return;
  }

  let apiKey: string;
  try {
    apiKey = decryptApiKey(channelId);
  } catch {
    emit.onError("解密 API Key 失败");
    return;
  }

  const modelId = pickModelId(channelId, input.modelId);

  const userMessageRecord: AgentMessage = {
    id: randomUUID(),
    role: "user",
    content: userMessage,
    createdAt: Date.now()
  };
  appendAgentMessage(sessionId, userMessageRecord);

  const history = buildHistoryForAdapter(getAgentSessionMessages(sessionId));

  const controller = new AbortController();
  activeControllers.set(sessionId, controller);

  const accumulator = createAgentStreamAccumulatorState();

  try {
    const adapter = getAdapter(channel.provider);
    const request = adapter.buildStreamRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId,
      history,
      userMessage,
      systemMessage: undefined,
      readImageAttachments: () => []
    });

    const { content } = await streamSSE({
      request,
      adapter,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "chunk") {
          const nextEvent: AgentEvent = { type: "text_delta", text: event.delta };
          appendAgentEvents(accumulator, [nextEvent]);
          emit.onEvent(nextEvent);
        }
      }
    });

    if (content) {
      const textComplete: AgentEvent = {
        type: "text_complete",
        text: content,
        isIntermediate: false
      };
      appendAgentEvents(accumulator, [textComplete]);
      emit.onEvent(textComplete);
    }

    const completeEvent: AgentEvent = { type: "complete" };
    appendAgentEvents(accumulator, [completeEvent]);
    emit.onEvent(completeEvent);

    const assistant = buildAssistantAgentMessage(accumulator, modelId);
    if (assistant) {
      appendAgentMessage(sessionId, assistant);
    }

    updateAgentSessionMeta(sessionId, {});
    emit.onComplete();

    await autoGenerateAgentTitle(sessionId, userMessage, channelId, modelId, emit);
  } catch (error) {
    if (controller.signal.aborted) {
      const abortedEvent: AgentEvent = { type: "complete" };
      appendAgentEvents(accumulator, [abortedEvent]);
      emit.onEvent(abortedEvent);

      const partialAssistant = buildAssistantAgentMessage(accumulator, modelId);
      if (partialAssistant) {
        appendAgentMessage(sessionId, partialAssistant);
      }

      updateAgentSessionMeta(sessionId, {});
      emit.onComplete();
      return;
    }

    const message = error instanceof Error ? error.message : "未知错误";
    emit.onError(message);
  } finally {
    activeControllers.delete(sessionId);
  }
}

export function stopAgent(sessionId: string): void {
  const controller = activeControllers.get(sessionId);
  if (!controller) return;
  controller.abort();
  activeControllers.delete(sessionId);
}

export function stopAllAgents(): void {
  for (const [sessionId, controller] of activeControllers) {
    controller.abort();
    activeControllers.delete(sessionId);
  }
}

export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  const channel = listChannels().find((item) => item.id === input.channelId);
  if (!channel) return null;

  let apiKey: string;
  try {
    apiKey = decryptApiKey(input.channelId);
  } catch {
    return null;
  }

  try {
    const adapter = getAdapter(channel.provider);
    const request = adapter.buildTitleRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId: input.modelId,
      prompt: AGENT_TITLE_PROMPT + input.userMessage
    });
    const title = await fetchTitle(request, adapter);
    if (!title) return null;
    const cleaned = title.trim().replace(/^["']+|["']+$/g, "").trim();
    return cleaned.slice(0, MAX_TITLE_LENGTH) || null;
  } catch {
    return null;
  }
}

async function autoGenerateAgentTitle(
  sessionId: string,
  userMessage: string,
  channelId: string,
  modelId: string,
  emit: AgentEventEmitter
): Promise<void> {
  try {
    const meta = getAgentSessionMeta(sessionId);
    if (!meta || meta.title !== DEFAULT_AGENT_TITLE) return;

    const title = await generateAgentTitle({ userMessage, channelId, modelId });
    if (!title) return;

    updateAgentSessionMeta(sessionId, { title });
    emit.onTitleUpdated(title);
  } catch {
    // 标题生成失败不影响主流程
  }
}
