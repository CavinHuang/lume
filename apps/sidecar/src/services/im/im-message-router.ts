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
  type ImMessageContent,
  type ImThreadBinding,
  type ImPeerKind,
  type ImProvider,
  type LumeRuntimeEvent,
  IM_PROVIDER_LABELS
} from "@lume/shared";
import { randomUUID } from "node:crypto";
import { emitAgentNotification } from "../agent/agent-notification-service";
import { createAgentThread, updateAgentThreadMeta } from "../agent/agent-thread-manager";
import { appendAgentMessage, submitAgentToolPermission } from "../agent/agent-service";
import { getAgentWorkspace } from "../agent/agent-workspace-manager";
import { saveFilesToAgentSession } from "../agent/agent-files-service";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { createLogger, writeLogRecord } from "../infra/logger";
import { getImAccount } from "./im-config-manager";
import {
  getImThreadBindingByPeer,
  getImThreadBindingByThreadId,
  upsertImThreadBinding
} from "./im-thread-binding-store";
import { sendBoundImTextMessage, type SendBoundImTextMessageInput } from "./im-send-service";
import { resolveMediaContents } from "./im-media-resolver";
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
}

type ImAgentStreamEmitter = {
  onRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  onMessageAppended?: (event: AgentMessageAppendedEvent) => void;
  onComplete: (payload?: { reason?: "max_turns" }) => void;
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
  sendBoundTextMessage: (input: SendBoundImTextMessageInput) => Promise<{ ok: true }>
): Promise<void> {
  const text = event.message.content.trim();
  if (!text) {
    return;
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
          message: error
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
    lines.push("群聊暂不支持通过微信审批工具权限，请在 Lume 桌面端处理。");
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
      text: "当前微信会话没有权限处理审批，请在 Lume 桌面端处理。"
    });
    return { threadId: binding.threadId };
  }
  if (binding.peerKind === "group") {
    await sendBoundTextMessage({
      binding,
      text: "群聊暂不支持通过微信审批工具权限，请在 Lume 桌面端处理。"
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
            log.error("微信回复发送失败", { threadId, error: message });
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
    onComplete: () => undefined,
    onError: (error) => {
      log.error("Agent 消息处理失败", { threadId, error });
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
          log.error("微信权限审批提示发送失败", { threadId, requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
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
  const existing = getImThreadBindingByPeer(message);
  const approvalCommand = parseImApprovalCommand(message.text);
  if (existing && approvalCommand.type !== "none") {
    log.info("处理审批命令", { peerId: message.peerId, requestId: approvalCommand.type === "command" ? approvalCommand.requestId : undefined });
    return routeImApprovalCommand(existing, approvalCommand, deps);
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

  await sendMessage({
    threadId: binding.threadId,
    userMessage: userMessageForMessage(message),
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
