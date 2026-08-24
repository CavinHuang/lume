import {
  AGENT_IPC_CHANNELS,
  type AgentAskUserQuestionRequest,
  type AgentMessageAppendedEvent,
  type AgentMessageAttachmentInput,
  type AgentSendInput,
  type AgentThreadMeta,
  type AgentThreadSource,
  type AgentToolPermissionDecision,
  type AgentToolPermissionRequest,
  type AgentToolPermissionResponseInput,
  type Channel,
  type ImMessageContent,
  type ImThreadBinding,
  type ImPeerKind,
  type ImProvider,
  type LumeRuntimeEvent,
  IM_PROVIDER_LABELS
} from "@lume/shared";
import { randomUUID } from "node:crypto";
import { emitAgentNotification } from "../agent/agent-notification-service";
import { createAgentThread, getAgentThreadMeta, updateAgentThreadMeta } from "../agent/agent-thread-manager";
import { appendAgentMessage, stopAgent, submitAgentToolPermission } from "../agent/agent-service";
import { getAgentWorkspace } from "../agent/agent-workspace-manager";
import { saveFilesToAgentSession } from "../agent/agent-files-service";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { createLogger, writeLogRecord } from "../infra/logger";
import { getImAccount, getImRuntimeAccount } from "./im-config-manager";
import { hasSeenImMessage, rememberImMessage } from "./im-seen-message-store";
import {
  deleteImThreadBindingByPeer,
  getImThreadBindingByPeer,
  getImThreadBindingByThreadId,
  upsertImThreadBinding
} from "./im-thread-binding-store";
import { sendBoundImTextMessage, type SendBoundImTextMessageInput } from "./im-send-service";
import { resolveMediaContents } from "./im-media-resolver";
import { createImRunCardSession, type ImRunCardSession } from "./im-run-card-session";
import { getFeishuQuotedMessage } from "./feishu/feishu-api";
import { redactSensitiveText } from "./im-log-redaction";
import {
  parseImCommand,
  formatChannelListText,
  formatImHelpText,
  formatImNowText,
  formatModelListText,
  listEnabledChannels,
  resolveImModelSwitch,
  type ParsedImCommand
} from "./im-chat-commands";
import { listChannels } from "../channel/channel-manager";
import { issuePlanningScopeGrant, registerPlanningExecutionContext } from "../planning/planning-execution-context";

const log = createLogger("im-router");

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
  contents?: ImMessageContent[];
  contextToken?: string;
  messageId?: string;
  /** 飞书长按回复场景的被引用消息 id */
  parentMessageId?: string;
  /** 结构化提及列表（飞书；供群准入精确匹配） */
  mentions?: Array<{ key?: string; openId?: string; name?: string }>;
  /** 原始文本是否含 @ 提及标记（群准入启发式线索） */
  hasMentionMarkup?: boolean;
}

export interface ImMessageRouterDeps {
  createThread?: (
    title: string,
    workspaceId?: string,
    options?: { fileContextMode: "newRoot" }
  ) => { id: string } | Promise<{ id: string }>;
  updateThreadMeta?: (threadId: string, patch: Pick<AgentThreadMeta, "source">) => void | Promise<void>;
  sendMessage?: (input: AgentSendInput) => void | Promise<void>;
  submitToolPermission?: (input: AgentToolPermissionResponseInput) => { ok: true };
  sendBoundTextMessage?: (input: SendBoundImTextMessageInput) => Promise<{ ok: true }>;
  emitNotification?: (method: string, params: unknown) => void;
  listChannels?: () => Channel[];
  stopThread?: (threadId: string) => Promise<boolean>;
  getThreadMeta?: (threadId: string) => AgentThreadMeta | undefined;
  updateThreadModelSelection?: (
    threadId: string,
    patch: Pick<AgentThreadMeta, "channelId" | "modelRef" | "modelId" | "modelSelectionSource">
  ) => void;
  /** 被引用消息内容解析（长按回复上下文注入）；默认仅飞书实现 */
  resolveQuotedMessage?: (
    message: InboundImRouteMessage
  ) => Promise<{ senderId?: string; text: string } | null>;
}

type ImAgentStreamEmitter = {
  onRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  onMessageAppended?: (event: AgentMessageAppendedEvent) => void;
  onComplete: (payload?: { reason?: "max_turns" | "repeat_guard" }) => void;
  onError: (error: string) => void;
  onTitleUpdated: (title: string) => void;
  onAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  onBrowserAuthRequest: () => void;
  onToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
};

interface ResolvedImApprovalPolicy {
  enabled: boolean;
  allowTextApprove: boolean;
  allowAlways: "disabled" | "desktop-only" | "dm-only";
  groupApproval: "disabled" | "desktop-only";
  approverPeerIds: string[];
}

interface CreateImAgentStreamEmitterOptions {
  emitNotification?: (method: string, params: unknown) => void;
  sendBoundTextMessage?: (input: SendBoundImTextMessageInput) => Promise<{ ok: true }>;
}

function titleForMessage(message: InboundImRouteMessage): string {
  const providerLabel = IM_PROVIDER_LABELS[message.provider];
  return `${providerLabel}: ${message.peerName?.trim() || message.peerId}`;
}

function userMessageForMessage(message: InboundImRouteMessage): string {
  if (message.peerKind === "group" && message.senderId?.trim()) {
    return `${message.senderId.trim()}: ${message.text}`;
  }
  return message.text;
}

/**
 * 构造带上下文的用户消息：存在被引用消息时以 XML 块注入引用内容，
 * 正文包进 <user_message>；无附加上下文时保持纯文本（历史行为不变）。
 */
export function buildImUserMessage(
  message: InboundImRouteMessage,
  quoted?: { senderId?: string; text: string } | null
): string {
  const base = userMessageForMessage(message);
  if (!quoted?.text) {
    return base;
  }
  const senderAttr = quoted.senderId ? ` sender="${quoted.senderId}"` : "";
  return [
    "<im_context>",
    `<quoted_message${senderAttr}>`,
    quoted.text,
    "</quoted_message>",
    "<user_message>",
    base,
    "</user_message>",
    "</im_context>"
  ].join("\n");
}

/** 飞书默认实现：按 parentMessageId 拉取被引用消息的可读文本。 */
async function resolveFeishuQuotedMessage(
  message: InboundImRouteMessage
): Promise<{ senderId?: string; text: string } | null> {
  if (message.provider !== "feishu" || !message.parentMessageId) {
    return null;
  }
  const account = getImRuntimeAccount(message.accountId);
  if (!account?.accountKey || !account.token) {
    return null;
  }
  return getFeishuQuotedMessage({
    appId: account.accountKey,
    appSecret: account.token,
    messageId: message.parentMessageId
  });
}

type ParsedImApprovalCommand =
  | { type: "none" }
  | { type: "invalid"; message: string }
  | { type: "command"; requestId: string; decision: AgentToolPermissionDecision };

function normalizeImApprovalDecision(raw: string): AgentToolPermissionDecision | null {
  const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "allow_once" || normalized === "once" || normalized === "allow") {
    return "allow_once";
  }
  if (normalized === "allow_always" || normalized === "always") {
    return "allow_always";
  }
  if (normalized === "deny" || normalized === "reject" || normalized === "no") {
    return "deny";
  }
  return null;
}

function parseImApprovalCommand(text: string): ParsedImApprovalCommand {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const head = parts[0]?.toLowerCase();
  if (!head || !/^\/approve(?:@\S+)?$/.test(head)) {
    return { type: "none" };
  }
  const requestId = parts[1]?.trim();
  const decision = parts[2] ? normalizeImApprovalDecision(parts[2]) : null;
  if (!requestId || !decision) {
    return {
      type: "invalid",
      message: "审批命令格式不正确。请回复：/approve <审批ID> allow-once 或 /approve <审批ID> deny"
    };
  }
  return { type: "command", requestId, decision };
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
  sendBoundTextMessage: (input: SendBoundImTextMessageInput) => Promise<{ ok: true }>,
  cardSession?: ImRunCardSession | null
): Promise<void> {
  const text = event.message.content.trim();
  if (!text) {
    return;
  }
  // 流式卡片通道可用时回复内容已由卡片承载，跳过整段文本投递避免重复
  if (cardSession) {
    const useCard = await cardSession.settleOpen();
    if (useCard) {
      log.info("助手回复经流式卡片承载，跳过文本投递", { threadId, textLength: text.length });
      return;
    }
  }
  const binding = getImThreadBindingByThreadId(threadId);
  if (!binding) {
    log.warn("自动回复失败：线程未绑定 IM 会话", { threadId });
    emitImDeliveryRuntimeEvent(threadId, event, undefined, "failed", emitNotification, "当前线程未绑定 IM 会话。");
    return;
  }
  log.info("投递助手回复到 IM", { threadId, peerId: binding.peerId, textLength: text.length });
  writeLogRecord({
    level: "info",
    kind: "trace",
    context: "agent.delivery.im",
    event: "reply.forwarded",
    message: "assistant reply forwarded to IM provider",
    status: "started",
    traceId: event.traceId,
    submissionId: event.submissionId,
    threadId,
    messageId: event.message.id,
    origin: `im.${binding.provider}`,
    data: { provider: binding.provider, accountId: binding.accountId, peerKind: binding.peerKind }
  });
  emitImDeliveryRuntimeEvent(threadId, event, binding, "pending", emitNotification);
  await sendBoundTextMessage({
    binding,
    text
  });
  emitImDeliveryRuntimeEvent(threadId, event, binding, "sent", emitNotification);
  writeLogRecord({
    level: "info",
    kind: "trace",
    context: "agent.delivery.im",
    event: "reply.committed",
    message: "IM provider acknowledged assistant reply",
    status: "ok",
    traceId: event.traceId,
    submissionId: event.submissionId,
    threadId,
    messageId: event.message.id,
    origin: `im.${binding.provider}`,
    data: { provider: binding.provider, accountId: binding.accountId, peerKind: binding.peerKind }
  });
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
          message: redactSensitiveText(error)
        }
      } : {})
    }
  });
}

function emitPermissionResolvedRuntimeEvent(
  threadId: string,
  input: AgentToolPermissionResponseInput,
  emitNotification: (method: string, params: unknown) => void
): void {
  const createdAt = new Date().toISOString();
  emitNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
    threadId,
    event: {
      id: `${threadId}:${input.requestId}:permission.resolved:${Date.now()}`,
      type: "permission.resolved",
      runId: `permission:${input.requestId}`,
      threadId,
      createdAt,
      requestId: input.requestId,
      decision: input.decision,
      source: "im"
    }
  });
}

function formatDecisionLabel(decision: AgentToolPermissionDecision): string {
  if (decision === "allow_once") return "允许一次";
  if (decision === "allow_always") return "始终允许";
  return "拒绝";
}

function resolveImApprovalWorkspaceSlug(binding: ImThreadBinding): string | undefined {
  const account = getImAccount(binding.accountId);
  if (!account?.workspaceId) return undefined;
  return getAgentWorkspace(account.workspaceId)?.slug;
}

function resolveImApprovalPolicy(binding: ImThreadBinding): ResolvedImApprovalPolicy {
  const im = getEffectiveLumeConfig(resolveImApprovalWorkspaceSlug(binding)).permissions?.approvals?.im;
  const account = im?.accounts?.[binding.accountId];
  return {
    enabled: account?.enabled ?? im?.enabled ?? true,
    allowTextApprove: account?.allowTextApprove ?? im?.allowTextApprove ?? true,
    allowAlways: account?.allowAlways ?? im?.allowAlways ?? "desktop-only",
    groupApproval: account?.groupApproval ?? im?.groupApproval ?? "desktop-only",
    approverPeerIds: account?.approverPeerIds ?? []
  };
}

function canBindingApproveViaIm(binding: ImThreadBinding, policy: ResolvedImApprovalPolicy): boolean {
  if (policy.approverPeerIds.length === 0) {
    return true;
  }
  return policy.approverPeerIds.includes(binding.peerId);
}

function formatToolPermissionRequestForIm(
  request: AgentToolPermissionRequest,
  binding: ImThreadBinding
): string | null {
  const policy = resolveImApprovalPolicy(binding);
  if (!policy.enabled) {
    return null;
  }
  const lines = [
    "需要确认工具执行",
    `工具: ${request.toolName}`,
    `风险: ${request.risk}`,
    `原因: ${request.reason}`,
    `审批 ID: ${request.requestId}`
  ];

  if (binding.peerKind === "group") {
    if (policy.groupApproval === "disabled") {
      return null;
    }
    lines.push("群聊审批未启用，请在 Lume 桌面端处理，请在 Lume 桌面端处理。");
    return lines.join("\n");
  }

  if (!policy.allowTextApprove) {
    lines.push("IM 审批未启用，请在 Lume 桌面端处理。");
    return lines.join("\n");
  }

  lines.push(
    "回复以下命令处理：",
    `/approve ${request.requestId} allow-once`,
    `/approve ${request.requestId} deny`
  );
  if (policy.allowAlways === "dm-only" && request.canAllowAlways !== false) {
    lines.push(`可选: /approve ${request.requestId} allow-always`);
  }
  return lines.join("\n");
}

async function deliverToolPermissionRequestToIm(
  request: AgentToolPermissionRequest,
  sendBoundTextMessage: (input: SendBoundImTextMessageInput) => Promise<{ ok: true }>
): Promise<void> {
  const binding = getImThreadBindingByThreadId(request.threadId)
    ?? (request.originThreadId ? getImThreadBindingByThreadId(request.originThreadId) : null);
  if (!binding) {
    return;
  }
  const text = formatToolPermissionRequestForIm(request, binding);
  if (!text) {
    return;
  }
  await sendBoundTextMessage({
    binding,
    text
  });
}

async function routeImApprovalCommand(
  binding: ImThreadBinding,
  command: Exclude<ParsedImApprovalCommand, { type: "none" }>,
  deps: ImMessageRouterDeps
): Promise<{ threadId: string }> {
  const sendBoundTextMessage = deps.sendBoundTextMessage ?? sendBoundImTextMessage;
  const emitNotification = deps.emitNotification ?? emitAgentNotification;
  if (command.type === "invalid") {
    await sendBoundTextMessage({ binding, text: command.message });
    return { threadId: binding.threadId };
  }
  const policy = resolveImApprovalPolicy(binding);
  if (!policy.enabled || !policy.allowTextApprove) {
    await sendBoundTextMessage({
      binding,
      text: "IM 审批未启用，请在 Lume 桌面端处理。"
    });
    return { threadId: binding.threadId };
  }
  if (!canBindingApproveViaIm(binding, policy)) {
    await sendBoundTextMessage({
      binding,
      text: "当前会话没有权限处理审批，请在 Lume 桌面端处理。"
    });
    return { threadId: binding.threadId };
  }
  if (binding.peerKind === "group") {
    await sendBoundTextMessage({
      binding,
      text: "群聊审批未启用，请在 Lume 桌面端处理，请在 Lume 桌面端处理。"
    });
    return { threadId: binding.threadId };
  }
  if (command.decision === "allow_always" && policy.allowAlways !== "dm-only") {
    await sendBoundTextMessage({
      binding,
      text: "IM 暂不允许授予始终允许，请在 Lume 桌面端处理。"
    });
    return { threadId: binding.threadId };
  }

  const input: AgentToolPermissionResponseInput = {
    threadId: binding.threadId,
    requestId: command.requestId,
    decision: command.decision
  };
  try {
    const submitToolPermission = deps.submitToolPermission ?? submitAgentToolPermission;
    submitToolPermission(input);
    emitPermissionResolvedRuntimeEvent(binding.threadId, input, emitNotification);
    await sendBoundTextMessage({
      binding,
      text: `已${formatDecisionLabel(command.decision)}审批请求 ${command.requestId}。`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendBoundTextMessage({
      binding,
      text: `审批请求 ${command.requestId} 处理失败：${message}`
    });
  }
  return { threadId: binding.threadId };
}

/** 无绑定线程时的命令回复载体（发送只用 provider/peer 字段）。 */
function transientBindingForReply(message: InboundImRouteMessage): ImThreadBinding {
  const now = Date.now();
  return {
    key: `transient:${message.provider}:${message.accountId}:${message.peerKind}:${message.peerId}`,
    provider: message.provider,
    accountId: message.accountId,
    peerKind: message.peerKind,
    peerId: message.peerId,
    ...(message.peerName ? { peerName: message.peerName } : {}),
    threadId: "",
    ...(message.contextToken ? { contextToken: message.contextToken } : {}),
    createdAt: now,
    updatedAt: now
  };
}

async function routeImChatCommand(
  message: InboundImRouteMessage,
  command: ParsedImCommand,
  existing: ImThreadBinding | null,
  deps: ImMessageRouterDeps
): Promise<{ threadId: string }> {
  const sendBoundTextMessage = deps.sendBoundTextMessage ?? sendBoundImTextMessage;
  const binding = existing ?? transientBindingForReply(message);
  const listAllChannels = deps.listChannels ?? listChannels;
  const stopThread = deps.stopThread ?? stopAgent;
  const getThreadMeta = deps.getThreadMeta ?? getAgentThreadMeta;
  const reply = async (text: string) => {
    await sendBoundTextMessage({ binding, text });
  };
  // 命令幂等：WS 重连/重启重投同一条命令不应重复执行（#157 同源语义）
  const rememberCommand = () => {
    if (message.messageId) {
      rememberImMessage(message.provider, message.accountId, message.messageId);
    }
  };

  switch (command.type) {
    case "invalid": {
      await reply(command.message);
      rememberCommand();
      break;
    }
    case "help": {
      await reply(formatImHelpText());
      rememberCommand();
      break;
    }
    case "new": {
      if (!existing) {
        await reply("发送任意消息即可开始新对话。");
        rememberCommand();
        break;
      }
      // 旧线程若有进行中运行先停止：否则其回复因绑定已换而静默丢失，
      // 且 IM 侧再也无法 /stop 它（审批请求同样悬空）
      try {
        await stopAgent(existing.threadId);
      } catch (error) {
        log.warn("/new 停止旧线程运行失败（继续重开）", {
          threadId: existing.threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      const thread = await (deps.createThread ?? ((title: string, workspaceId?: string, options?: { fileContextMode: "newRoot" }) =>
        createAgentThread(title, undefined, workspaceId, undefined, undefined, options)))(
        titleForMessage(message),
        message.workspaceId,
        { fileContextMode: "newRoot" }
      );
      // upsert 对既有 key 只更新 contextToken 不换绑线程，重开会话须先解绑
      deleteImThreadBindingByPeer(message);
      upsertImThreadBinding({
        provider: message.provider,
        accountId: message.accountId,
        peerKind: message.peerKind,
        peerId: message.peerId,
        peerName: message.peerName,
        threadId: thread.id,
        contextToken: message.contextToken
      });
      await updateThreadSourceMeta(thread.id, message, deps);
      log.info("IM 命令开启新对话", { provider: message.provider, peerId: message.peerId, threadId: thread.id });
      await reply("已开启新对话，接下来的消息将在全新的上下文中处理。");
      rememberCommand();
      return { threadId: thread.id };
    }
    case "stop": {
      let stopped = false;
      let failed = false;
      try {
        stopped = await stopThread(binding.threadId);
      } catch (error) {
        failed = true;
        log.warn("IM 命令停止任务失败", {
          threadId: binding.threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      await reply(
        failed
          ? "停止失败，请稍后重试或在 Lume 桌面端处理。"
          : stopped
            ? "已停止当前正在进行的任务。"
            : "当前没有正在进行的任务。"
      );
      rememberCommand();
      break;
    }
    case "now": {
      const meta = existing ? getThreadMeta(existing.threadId) ?? null : null;
      await reply(
        formatImNowText({
          peerKind: message.peerKind,
          meta,
          channels: listAllChannels(),
          ...(meta?.workspaceId ? { workspaceId: meta.workspaceId } : {})
        })
      );
      rememberCommand();
      break;
    }
    case "model": {
      const allChannels = listAllChannels();
      const enabledChannels = listEnabledChannels(allChannels);
      if (command.args.length === 0) {
        await reply(formatChannelListText(allChannels));
        rememberCommand();
        break;
      }
      if (command.args.length === 1) {
        const channelIndex = Number.parseInt(command.args[0] ?? "", 10);
        const channel = Number.isNaN(channelIndex) ? undefined : enabledChannels[channelIndex - 1];
        await reply(
          channel
            ? formatModelListText(channel)
            : `渠道序号无效。发送 /model 查看 1-${enabledChannels.length} 号渠道。`
        );
        rememberCommand();
        break;
      }
      if (!existing) {
        await reply("请先发送任意消息建立会话，再使用 /model 切换模型。");
        rememberCommand();
        break;
      }
      const result = resolveImModelSwitch(allChannels, command.args);
      if (!result.ok) {
        await reply(result.message);
        rememberCommand();
        break;
      }
      try {
        (deps.updateThreadModelSelection ?? updateAgentThreadMeta)(existing.threadId, {
          channelId: result.channelId,
          modelRef: result.modelRef,
          modelId: result.modelId,
          modelSelectionSource: "thread-override"
        });
        log.info("IM 命令切换模型", {
          threadId: existing.threadId,
          channelId: result.channelId,
          modelRef: result.modelRef
        });
        await reply(`已切换模型：${result.modelName}（渠道「${result.channelName}」），仅当前会话生效。`);
      } catch (error) {
        // 陈旧绑定（线程已被桌面端删除）等：明确告知而非静默失败
        log.warn("IM 命令切换模型失败", {
          threadId: existing.threadId,
          error: error instanceof Error ? error.message : String(error)
        });
        await reply("切换失败：当前绑定的会话已不存在，发送任意消息可重新建立会话。");
      }
      rememberCommand();
      break;
    }
    default:
      break;
  }
  return { threadId: existing?.threadId ?? "" };
}

async function updateThreadSourceMeta(
  threadId: string,
  message: InboundImRouteMessage,
  deps: ImMessageRouterDeps
): Promise<void> {
  const updateThreadMeta = deps.updateThreadMeta ?? (
    deps.createThread
      ? undefined
      : (id: string, patch: Pick<AgentThreadMeta, "source">) => {
          updateAgentThreadMeta(id, patch);
        }
  );
  if (updateThreadMeta) {
    await updateThreadMeta(threadId, { source: sourceForMessage(message) });
  }
}

export function createImAgentStreamEmitter(
  threadId: string,
  options: CreateImAgentStreamEmitterOptions = {}
): ImAgentStreamEmitter {
  const emitNotification = options.emitNotification ?? emitAgentNotification;
  const sendBoundTextMessage = options.sendBoundTextMessage ?? sendBoundImTextMessage;
  // 飞书渠道启用流式卡片会话；其余渠道为 null 走原文本投递
  const cardSession = createImRunCardSession(threadId);

  return {
    onRuntimeEvent: (event) => {
      cardSession?.handleEvent(event);
      emitNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
        threadId,
        event
      });
    },
    onMessageAppended: (event) => {
      emitNotification(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, event);
      emitUserSubmittedRuntimeEvent(threadId, event, emitNotification);
      if (event.message.role === "assistant" && event.message.content.trim()) {
        void deliverAssistantReplyToIm(threadId, event, emitNotification, sendBoundTextMessage, cardSession)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            log.error("IM 回复发送失败", { threadId, error: message });
            const binding = getImThreadBindingByThreadId(threadId) ?? undefined;
            emitImDeliveryRuntimeEvent(threadId, event, binding, "failed", emitNotification, message);
            writeLogRecord({
              level: "error",
              kind: "trace",
              context: "agent.delivery.im",
              event: "reply.delivery_failed",
              message: "IM assistant reply delivery failed",
              status: "error",
              traceId: event.traceId,
              submissionId: event.submissionId,
              threadId,
              messageId: event.message.id,
              origin: binding ? `im.${binding.provider}` : "im.unknown",
              error: { message }
            });
          });
      }
    },
    onComplete: (payload) => {
      // 卡片终态：达到轮次上限/重复护栏单独标注，其余按完成
      cardSession?.finish({
        kind: payload?.reason === "max_turns" || payload?.reason === "repeat_guard" ? "turn_limited" : "completed"
      });
    },
    onError: (error) => {
      log.error("Agent 消息处理失败", { threadId, error });
      cardSession?.finish({ kind: "failed", error });
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
    onBrowserAuthRequest: () => {
      emitRuntimeError(threadId, "IM 通道不支持浏览器安全凭证交互", emitNotification);
    },
    onToolPermissionRequest: (request) => {
      emitNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request);
      void deliverToolPermissionRequestToIm(request, sendBoundTextMessage)
        .catch((error) => {
          log.error("IM 权限审批提示发送失败", { threadId, requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
        });
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
  log.info("收到入站消息", { provider: message.provider, accountId: message.accountId, peerId: message.peerId, peerKind: message.peerKind, peerName: message.peerName, textLength: message.text.length });

  // 统一去重（#157）：四渠道 at-least-once 重投（WS 重连/服务端重试/进程重启）只处理一次。
  // messageId 缺失（部分事件类型无 id）跳过去重，避免 key 塌缩吞掉整账号消息。
  if (message.messageId && hasSeenImMessage(message.provider, message.accountId, message.messageId)) {
    log.info("重复消息，跳过路由", { provider: message.provider, accountId: message.accountId, messageId: message.messageId });
    const existingBinding = getImThreadBindingByPeer(message);
    return { threadId: existingBinding?.threadId ?? "" };
  }
  const existing = getImThreadBindingByPeer(message);
  const approvalCommand = parseImApprovalCommand(message.text);
  if (existing && approvalCommand.type !== "none") {
    log.info("处理审批命令", { peerId: message.peerId, requestId: approvalCommand.type === "command" ? approvalCommand.requestId : undefined });
    return routeImApprovalCommand(existing, approvalCommand, deps);
  }
  // 会话内斜杠命令（/help /new /stop /now /model）
  const chatCommand = parseImCommand(message.text);
  if (chatCommand.type !== "none") {
    log.info("处理会话命令", { provider: message.provider, peerId: message.peerId, type: chatCommand.type });
    return routeImChatCommand(message, chatCommand, existing, deps);
  }
  const thread = existing
    ? { id: existing.threadId }
    : await (deps.createThread ?? ((title: string, workspaceId?: string, options?: { fileContextMode: "newRoot" }) =>
      createAgentThread(title, undefined, workspaceId, undefined, undefined, options)))(
      titleForMessage(message),
      message.workspaceId,
      { fileContextMode: "newRoot" }
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

  await updateThreadSourceMeta(binding.threadId, message, deps);


  const sendMessage = deps.sendMessage ?? defaultSendMessage;

  // Resolve media contents: download images/files into the thread attachment
  // directory so the agent can read them via file tools (and images become
  // multimodal input). Falls back gracefully when the workspace is unavailable.
  const messageContents = message.contents ?? [];
  const workspaceSlug = message.workspaceId ? getAgentWorkspace(message.workspaceId)?.slug : undefined;
  const cdnBaseUrl = getImAccount(message.accountId)?.baseUrl;
  const saveMedia = buildImSaveMedia(workspaceSlug, binding.threadId);
  const resolvedContents = messageContents.length > 0
    ? await resolveMediaContents(messageContents, { saveMedia, cdnBaseUrl })
    : [];

  const mediaAttachments = buildImMediaAttachments(resolvedContents, message.messageId);
  const submissionId = randomUUID();
  registerPlanningExecutionContext({
    surface: "im",
    threadId: binding.threadId,
    clientSubmissionId: submissionId,
    ...(message.workspaceId ? { workspaceId: message.workspaceId } : {})
  });
  const imScope = message.workspaceId ? "current" : "unassigned";
  issuePlanningScopeGrant({
    clientSubmissionId: submissionId,
    surface: "im",
    scope: imScope,
    ...(message.workspaceId ? { workspaceId: message.workspaceId } : {}),
    allowedOperations: ["list", "get"],
    mode: "turn"
  });

  // 长按回复：尽力解析被引用消息注入上下文；失败降级为纯正文（不阻断路由）
  const quoted = message.parentMessageId
    ? await (deps.resolveQuotedMessage ?? resolveFeishuQuotedMessage)(message).catch(() => null)
    : null;

  await sendMessage({
    threadId: binding.threadId,
    userMessage: buildImUserMessage(message, quoted),
    messageAttachments: mediaAttachments.length > 0 ? mediaAttachments : undefined,
    workspaceId: message.workspaceId,
    trustedPlanningClientSubmissionId: submissionId,
    chatType: message.peerKind === "group" ? "group" : "direct",
    threadType: message.peerKind === "group" ? "group" : "main",
    traceContext: {
      submissionId,
      traceId: randomUUID(),
      origin: `im.${message.provider}`
    },
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

  // 路由成功后才标记已见：微信渠道靠 cursor 重投失败消息，若先标记再失败会丢消息
  if (message.messageId) {
    rememberImMessage(message.provider, message.accountId, message.messageId);
  }

  return { threadId: binding.threadId };
}

/** Build a saveMedia callback that persists downloaded IM media into the thread attachment directory. */
function buildImSaveMedia(
  workspaceSlug: string | undefined,
  threadId: string
): ((input: { filename: string; data: Buffer; mediaType: string }) => Promise<string | undefined>) | undefined {
  if (!workspaceSlug) return undefined;
  return async (input) => {
    try {
      const [saved] = saveFilesToAgentSession({
        workspaceSlug,
        threadId,
        files: [{ filename: input.filename, data: input.data.toString("base64") }],
      });
      return saved?.threadPath;
    } catch (error) {
      log.warn("保存 IM 媒体失败", {
        threadId,
        filename: input.filename,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
}

/** Convert resolved image/file contents into agent message attachments. */
function buildImMediaAttachments(
  contents: ImMessageContent[],
  messageId?: string
): AgentMessageAttachmentInput[] {
  const baseId = messageId ?? Date.now();
  const attachments: AgentMessageAttachmentInput[] = [];
  let imgIdx = 0;
  let fileIdx = 0;
  for (const content of contents) {
    if (content.type === "image" && content.url) {
      attachments.push({
        id: `im-media-${baseId}-img-${imgIdx}`,
        filename: basenameFromPath(content.url) || `im-image-${imgIdx}.jpg`,
        mediaType: inferImMediaType(content.url),
        size: 0,
        threadPath: content.url,
      });
      imgIdx += 1;
    } else if (content.type === "file" && content.downloadUrl) {
      attachments.push({
        id: `im-media-${baseId}-file-${fileIdx}`,
        filename: content.fileName,
        mediaType: inferImMediaType(content.fileName),
        size: content.fileSize,
        threadPath: content.downloadUrl,
      });
      fileIdx += 1;
    }
  }
  return attachments;
}

function basenameFromPath(path: string): string {
  const cleaned = path.split("?")[0]?.split("#")[0] ?? "";
  const last = cleaned.split("/").pop();
  return last && last.length > 0 ? last : "";
}

const IM_IMAGE_EXT_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function inferImMediaType(filename: string): string {
  const ext = filename.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
  return IM_IMAGE_EXT_MEDIA_TYPE[ext] ?? "application/octet-stream";
}
