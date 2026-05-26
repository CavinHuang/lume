import {
  AGENT_IPC_CHANNELS,
  type AgentAskUserQuestionRequest,
  type AgentMessageAppendedEvent,
  type AgentSendInput,
  type AgentThreadMeta,
  type AgentThreadSource,
  type AgentToolPermissionRequest,
  type ImThreadBinding,
  type ImPeerKind,
  type ImProvider,
  type LumeRuntimeEvent
} from "@lume/shared";
import { emitAgentNotification } from "../agent/agent-notification-service";
import { createAgentThread, updateAgentThreadMeta } from "../agent/agent-thread-manager";
import { appendAgentMessage } from "../agent/agent-service";
import {
  getImThreadBindingByPeer,
  getImThreadBindingByThreadId,
  upsertImThreadBinding
} from "./im-thread-binding-store";
import { sendBoundImTextMessage, type SendBoundImTextMessageInput } from "./im-send-service";

export interface InboundImRouteMessage {
  provider: ImProvider;
  accountId: string;
  accountLabel?: string;
  workspaceId?: string;
  peerKind: ImPeerKind;
  peerId: string;
  peerName?: string;
  senderId?: string;
  text: string;
  contextToken?: string;
  messageId?: string;
}

export interface ImMessageRouterDeps {
  createThread?: (title: string, workspaceId?: string) => { id: string } | Promise<{ id: string }>;
  updateThreadMeta?: (threadId: string, patch: Pick<AgentThreadMeta, "source">) => void | Promise<void>;
  sendMessage?: (input: AgentSendInput) => void | Promise<void>;
}

type ImAgentStreamEmitter = {
  onRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  onMessageAppended?: (event: AgentMessageAppendedEvent) => void;
  onComplete: (payload?: { reason?: "max_turns" }) => void;
  onError: (error: string) => void;
  onTitleUpdated: (title: string) => void;
  onAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  onToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
};

interface CreateImAgentStreamEmitterOptions {
  emitNotification?: (method: string, params: unknown) => void;
  sendBoundTextMessage?: (input: SendBoundImTextMessageInput) => Promise<{ ok: true }>;
}

function titleForMessage(message: InboundImRouteMessage): string {
  return `微信: ${message.peerName?.trim() || message.peerId}`;
}

function userMessageForMessage(message: InboundImRouteMessage): string {
  if (message.peerKind === "group" && message.senderId?.trim()) {
    return `${message.senderId.trim()}: ${message.text}`;
  }
  return message.text;
}

function sourceForMessage(message: InboundImRouteMessage): AgentThreadSource {
  return {
    type: "im",
    provider: message.provider,
    accountId: message.accountId,
    ...(message.accountLabel ? { accountLabel: message.accountLabel } : {}),
    peerKind: message.peerKind,
    peerId: message.peerId,
    ...(message.peerName ? { peerName: message.peerName } : {})
  };
}

function emitUserSubmittedRuntimeEvent(
  threadId: string,
  event: AgentMessageAppendedEvent,
  emitNotification: (method: string, params: unknown) => void
): void {
  if (event.message.role !== "user" || typeof event.message.content !== "string") {
    return;
  }
  const createdAt = new Date(event.message.createdAt ?? Date.now()).toISOString();
  emitNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
    threadId,
    event: {
      id: `${threadId}:${event.message.id ?? createdAt}:message.user.submitted`,
      type: "message.user.submitted",
      runId: `message:${event.message.id ?? createdAt}`,
      threadId,
      text: event.message.content,
      createdAt,
      messageId: event.message.id,
      versionGroupId: event.message.versionGroupId,
      versionIndex: event.message.versionIndex,
      versionCount: event.message.versionCount
    }
  });
}

async function deliverAssistantReplyToIm(
  threadId: string,
  event: AgentMessageAppendedEvent,
  emitNotification: (method: string, params: unknown) => void,
  sendBoundTextMessage: (input: SendBoundImTextMessageInput) => Promise<{ ok: true }>
): Promise<void> {
  const text = event.message.content.trim();
  if (!text) {
    return;
  }
  const binding = getImThreadBindingByThreadId(threadId);
  if (!binding) {
    emitImDeliveryRuntimeEvent(threadId, event, undefined, "failed", emitNotification, "当前线程未绑定 IM 会话。");
    return;
  }
  emitImDeliveryRuntimeEvent(threadId, event, binding, "pending", emitNotification);
  await sendBoundTextMessage({
    binding,
    text
  });
  emitImDeliveryRuntimeEvent(threadId, event, binding, "sent", emitNotification);
}

function emitRuntimeError(
  threadId: string,
  message: string,
  emitNotification: (method: string, params: unknown) => void
): void {
  emitNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
    threadId,
    event: {
      id: `${threadId}:${Date.now()}:run.failed`,
      type: "run.failed",
      threadId,
      runId: `runtime-error:${threadId}`,
      createdAt: new Date().toISOString(),
      error: {
        code: "runtime_error",
        message
      }
    }
  });
}

function emitImDeliveryRuntimeEvent(
  threadId: string,
  event: AgentMessageAppendedEvent,
  binding: ImThreadBinding | undefined,
  status: "pending" | "sent" | "failed",
  emitNotification: (method: string, params: unknown) => void,
  error?: string
): void {
  emitNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
    threadId,
    event: {
      id: `${threadId}:${event.message.id}:im.delivery:${status}:${Date.now()}`,
      type: "im.delivery",
      runId: `message:${event.message.id}`,
      threadId,
      createdAt: new Date().toISOString(),
      messageId: event.message.id,
      provider: binding?.provider ?? "weixin",
      accountId: binding?.accountId ?? "",
      peerKind: binding?.peerKind ?? "dm",
      peerId: binding?.peerId ?? "",
      status,
      ...(error ? {
        error: {
          code: "im_delivery_failed",
          message: error
        }
      } : {})
    }
  });
}

export function createImAgentStreamEmitter(
  threadId: string,
  options: CreateImAgentStreamEmitterOptions = {}
): ImAgentStreamEmitter {
  const emitNotification = options.emitNotification ?? emitAgentNotification;
  const sendBoundTextMessage = options.sendBoundTextMessage ?? sendBoundImTextMessage;

  return {
    onRuntimeEvent: (event) => {
      emitNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
        threadId,
        event
      });
    },
    onMessageAppended: (event) => {
      emitNotification(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, event);
      emitUserSubmittedRuntimeEvent(threadId, event, emitNotification);
      if (event.message.role === "assistant" && event.message.content.trim()) {
        void deliverAssistantReplyToIm(threadId, event, emitNotification, sendBoundTextMessage)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[IM] 微信回复发送失败:", error);
            const binding = getImThreadBindingByThreadId(threadId) ?? undefined;
            emitImDeliveryRuntimeEvent(threadId, event, binding, "failed", emitNotification, message);
          });
      }
    },
    onComplete: () => undefined,
    onError: (error) => {
      console.error("[IM] Agent 消息发送失败:", error);
      emitRuntimeError(threadId, error, emitNotification);
    },
    onTitleUpdated: (title) => {
      emitNotification(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
        threadId,
        title
      });
    },
    onAskUserQuestion: (request) => {
      emitNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request);
    },
    onToolPermissionRequest: (request) => {
      emitNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request);
    }
  };
}

async function defaultSendMessage(input: AgentSendInput): Promise<void> {
  appendAgentMessage(input, createImAgentStreamEmitter(input.threadId));
}

export async function routeInboundImMessage(
  message: InboundImRouteMessage,
  deps: ImMessageRouterDeps = {}
): Promise<{ threadId: string }> {
  const existing = getImThreadBindingByPeer(message);
  const thread = existing
    ? { id: existing.threadId }
    : await (deps.createThread ?? ((title: string, workspaceId?: string) => createAgentThread(title, undefined, workspaceId)))(
      titleForMessage(message),
      message.workspaceId
    );

  const binding = upsertImThreadBinding({
    provider: message.provider,
    accountId: message.accountId,
    peerKind: message.peerKind,
    peerId: message.peerId,
    peerName: message.peerName,
    threadId: thread.id,
    contextToken: message.contextToken
  });

  const updateThreadMeta = deps.updateThreadMeta ?? (
    deps.createThread
      ? undefined
      : (threadId: string, patch: Pick<AgentThreadMeta, "source">) => {
          updateAgentThreadMeta(threadId, patch);
        }
  );
  if (updateThreadMeta) {
    await updateThreadMeta(binding.threadId, {
      source: sourceForMessage(message)
    });
  }

  const sendMessage = deps.sendMessage ?? defaultSendMessage;
  await sendMessage({
    threadId: binding.threadId,
    userMessage: userMessageForMessage(message),
    workspaceId: message.workspaceId,
    chatType: message.peerKind === "group" ? "group" : "direct",
    threadType: message.peerKind === "group" ? "group" : "main",
    messageMetadata: {
      im: {
        provider: message.provider,
        accountId: message.accountId,
        accountLabel: message.accountLabel,
        workspaceId: message.workspaceId,
        peerKind: message.peerKind,
        peerId: message.peerId,
        peerName: message.peerName,
        senderId: message.senderId,
        contextToken: message.contextToken,
        messageId: message.messageId
      },
      toolPolicy: {
        deny: ["send_im_message"]
      }
    }
  });

  return { threadId: binding.threadId };
}
