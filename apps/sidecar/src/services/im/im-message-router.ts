import type { AgentSendInput, AgentThreadMeta, AgentThreadSource, ImPeerKind, ImProvider } from "@lume/shared";
import { createAgentThread, updateAgentThreadMeta } from "../agent/agent-thread-manager";
import { appendAgentMessage } from "../agent/agent-service";
import {
  getImThreadBindingByPeer,
  upsertImThreadBinding
} from "./im-thread-binding-store";

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

async function defaultSendMessage(input: AgentSendInput): Promise<void> {
  appendAgentMessage(input, {
    onComplete: () => undefined,
    onError: (error) => console.error("[IM] Agent 消息发送失败:", error),
    onTitleUpdated: () => undefined,
    onAskUserQuestion: () => undefined,
    onToolPermissionRequest: () => undefined
  });
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
        allow: ["send_im_message"]
      }
    }
  });

  return { threadId: binding.threadId };
}
