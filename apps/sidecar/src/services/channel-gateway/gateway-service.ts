import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type {
  ChannelDeliveryRecord,
  ChannelGatewayIngressInput,
  ChannelGatewayIngressResult,
  ChannelGatewayListDeliveriesInput,
  ChannelInboundEvent,
  ChannelOutboundMessage,
  ChannelProvider
} from "@lume/shared";
import type { Channel } from "@lume/shared";
import { createAgentSession, getAgentSessionMessages } from "../agent-session-manager";
import { sendAgentMessage } from "../agent-service";
import { listChannels } from "../channel-manager";
import { getChannelGatewayDeliveryPath } from "../config-paths";
import {
  findChannelSessionBinding,
  listChannelSessionBindings,
  upsertChannelSessionBinding
} from "./binding-manager";
import { isChannelEventProcessed, markChannelEventProcessed } from "./dedup-manager";
import { enqueueChannelRetry } from "./retry-queue-manager";
import { sendFeishuTextMessage } from "./feishu-api";

function pickModelId(channel: Channel): string | null {
  const enabledModels = channel.models.filter((model) => model.enabled);
  if (enabledModels.length === 0) return null;
  if (channel.defaultModelId) {
    const hit = enabledModels.find((model) => model.id === channel.defaultModelId);
    if (hit) return hit.id;
  }
  return enabledModels[0]?.id ?? null;
}

function pickExecutionChannel(): { channelId: string; modelId: string } {
  const channels = listChannels().filter((channel) => channel.enabled);
  if (channels.length === 0) {
    throw new Error("未找到可用渠道，请先在设置中配置并启用 Agent 渠道");
  }
  const withModel = channels.find((channel) => pickModelId(channel) !== null);
  if (!withModel) {
    throw new Error("未找到可用模型，请先在渠道里启用至少一个模型");
  }
  const modelId = pickModelId(withModel);
  if (!modelId) {
    throw new Error("渠道缺少可用模型");
  }
  return { channelId: withModel.id, modelId };
}

function appendDelivery(record: ChannelDeliveryRecord): void {
  appendFileSync(getChannelGatewayDeliveryPath(), `${JSON.stringify(record)}\n`, "utf-8");
}

function pickLatestAssistantText(sessionId: string): string {
  const messages = getAgentSessionMessages(sessionId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const content = (message.content ?? "").trim();
    if (content) return content;
  }
  return "任务执行完成，但未生成可读回复。";
}

function createOutboundFromEvent(event: ChannelInboundEvent, sessionId: string, text: string): ChannelOutboundMessage {
  return {
    id: randomUUID(),
    provider: event.provider,
    externalChatId: event.externalChatId,
    inReplyToEventId: event.id,
    sessionId,
    ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
    text,
    createdAt: Date.now()
  };
}

export async function simulateChannelGatewayIngress(
  input: ChannelGatewayIngressInput
): Promise<ChannelGatewayIngressResult> {
  const event = input.event;
  if (isChannelEventProcessed(event)) {
    return { accepted: true, duplicate: true };
  }
  markChannelEventProcessed(event);

  const binding = findChannelSessionBinding({
    provider: event.provider,
    externalChatId: event.externalChatId,
    externalUserId: event.externalUserId
  });

  let finalBinding = binding;
  let sessionId = binding?.sessionId;
  let preparedOutbound: ChannelOutboundMessage | null = null;

  try {
    const { channelId, modelId } = pickExecutionChannel();
    if (!sessionId) {
      const created = createAgentSession(`[Channel:${event.provider}] ${event.externalChatId}`, channelId, event.workspaceId);
      sessionId = created.id;
      finalBinding = upsertChannelSessionBinding({
        provider: event.provider,
        externalChatId: event.externalChatId,
        externalUserId: event.externalUserId,
        workspaceId: event.workspaceId,
        sessionId
      });
    }

    let runtimeError: string | null = null;
    await sendAgentMessage(
      {
        sessionId,
        userMessage: event.text,
        workspaceId: event.workspaceId,
        channelId,
        modelId,
        permissionMode: "bypassPermissions",
        messageMetadata: {
          source: "channel_gateway",
          channelProvider: event.provider,
          externalChatId: event.externalChatId,
          externalMessageId: event.externalMessageId
        }
      },
      {
        onEvent: () => {},
        onComplete: () => {},
        onError: (error) => {
          runtimeError = error;
        },
        onTitleUpdated: () => {},
        onAskUserQuestion: () => {
          runtimeError = "外部渠道网关模式禁止交互";
        },
        onToolPermissionRequest: () => {
          runtimeError = "外部渠道网关模式禁止权限交互";
        }
      },
      { appendUserMessage: true }
    );

    if (runtimeError) {
      throw new Error(runtimeError);
    }

    const outbound = createOutboundFromEvent(event, sessionId, pickLatestAssistantText(sessionId));
    preparedOutbound = outbound;
    let externalMessageId = `mock:${outbound.id}`;
    if (event.provider === "feishu") {
      const sent = await sendFeishuTextMessage({
        chatId: event.externalChatId,
        text: outbound.text,
        replyToMessageId: event.externalMessageId
      });
      externalMessageId = sent.messageId;
    }

    const delivery: ChannelDeliveryRecord = {
      id: randomUUID(),
      provider: event.provider,
      outboundMessageId: outbound.id,
      status: "sent",
      attempts: 1,
      externalMessageId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    appendDelivery(delivery);

    return {
      accepted: true,
      duplicate: false,
      ...(finalBinding ? { binding: finalBinding } : {}),
      outbound,
      delivery
    };
  } catch (error) {
    const outbound = preparedOutbound ?? createOutboundFromEvent(event, sessionId ?? "unknown", "");
    const message = error instanceof Error ? error.message : String(error);
    const delivery: ChannelDeliveryRecord = {
      id: randomUUID(),
      provider: event.provider,
      outboundMessageId: outbound.id,
      status: "failed",
      attempts: 1,
      error: message,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    appendDelivery(delivery);
    enqueueChannelRetry({
      provider: event.provider,
      outboundMessageId: outbound.id,
      reason: message,
      externalChatId: outbound.externalChatId,
      text: outbound.text,
      ...(event.externalMessageId ? { replyToMessageId: event.externalMessageId } : {})
    });
    return {
      accepted: false,
      duplicate: false,
      ...(finalBinding ? { binding: finalBinding } : {}),
      outbound,
      delivery,
      error: message
    };
  }
}

export function listChannelGatewayBindings() {
  return listChannelSessionBindings();
}

export function listChannelGatewayDeliveries(
  input: ChannelGatewayListDeliveriesInput = {}
): ChannelDeliveryRecord[] {
  const path = getChannelGatewayDeliveryPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n");
  const rows: ChannelDeliveryRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ChannelDeliveryRecord;
      if (parsed?.id) rows.push(parsed);
    } catch {
      // ignore bad line
    }
  }
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  return rows
    .filter((item) => (input.provider ? item.provider === input.provider : true))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export function upsertChannelGatewayBinding(input: {
  provider: ChannelProvider;
  externalChatId: string;
  externalUserId?: string;
  workspaceId?: string;
  sessionId: string;
}) {
  return upsertChannelSessionBinding(input);
}
