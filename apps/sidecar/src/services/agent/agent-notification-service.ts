import {
  AGENT_IPC_CHANNELS,
  RPC_ERROR_CODES,
  type AgentCapabilityReferenceView,
  type AgentMessage,
  type AgentUserMessagePart,
  type LumeRuntimeEvent,
  type SensitiveDiagnosticEnvelope
} from "@lume/shared";
import type { appendAgentMessage } from "./agent-service";
import { getPersistedGeneralSettings } from "../system/general-settings-service";
import { getOutboundNotificationWriter } from "../infra/outbound-notification";

type AgentNotificationWriter = (method: string, params: unknown) => void;
type AgentStreamEmitter = Parameters<typeof appendAgentMessage>[1];

export function emitAgentNotification(method: string, params: unknown): void {
  getOutboundNotificationWriter()?.(method, params);
}

// #553 第四轮补充:RUNTIME_EVENT 的 envelope({threadId,event}) 组装与
// id/runId 字段口径收敛本文件单点,各域只声明「发什么类型的事件」
export function emitRuntimeEventNotification(
  threadId: string,
  event: LumeRuntimeEvent,
  writeNotification: AgentNotificationWriter = emitAgentNotification
): void {
  writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId, event });
}

export function createUserSubmittedRuntimeEvent(
  threadId: string,
  message: AgentMessage
): Extract<LumeRuntimeEvent, { type: "message.user.submitted" }> {
  const createdAt = new Date(message.createdAt ?? Date.now()).toISOString();
  const messageKey = message.id ?? createdAt;
  return {
    id: `${threadId}:${messageKey}:message.user.submitted`,
    type: "message.user.submitted",
    runId: `message:${messageKey}`,
    threadId,
    text: message.content,
    createdAt,
    messageId: message.id,
    versionGroupId: message.versionGroupId,
    versionIndex: message.versionIndex,
    versionCount: message.versionCount,
    messageParts: message.metadata?.messageParts as AgentUserMessagePart[] | undefined,
    capabilityReferences: message.metadata?.capabilityReferenceViews as AgentCapabilityReferenceView[] | undefined
  };
}

export function createRunFailedRuntimeEvent(
  threadId: string,
  message: string
): Extract<LumeRuntimeEvent, { type: "run.failed" }> {
  return {
    id: `${threadId}:${Date.now()}:run.failed`,
    type: "run.failed",
    threadId,
    runId: `runtime-error:${threadId}`,
    createdAt: new Date().toISOString(),
    error: {
      code: RPC_ERROR_CODES.NOTIFICATION_RUNTIME_ERROR,
      message
    }
  };
}

export function createAgentNotificationEmitter(input: {
  threadId: string;
  writeNotification?: AgentNotificationWriter;
  onComplete?: AgentStreamEmitter["onComplete"];
  onError?: AgentStreamEmitter["onError"];
}): AgentStreamEmitter {
  const writeNotification = input.writeNotification ?? emitAgentNotification;
  return {
    onRuntimeEvent: (event) => {
      const eventThreadId = typeof event.threadId === "string" ? event.threadId : input.threadId;
      emitRuntimeEventNotification(eventThreadId, event, writeNotification);
    },
    onMessageAppended: (event) => {
      writeNotification(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, event);
      if (event.message.role !== "user" || typeof event.message.content !== "string") return;

      emitRuntimeEventNotification(input.threadId, createUserSubmittedRuntimeEvent(input.threadId, event.message), writeNotification);
    },
    onComplete: (payload) => input.onComplete?.(payload),
    onError: (error, options) => {
      // T7c 收编(fix round 1):fromActiveRun=true 表示错误来自 run 执行链
      // (agent-service 内层 onError 转发,run 终值已由总线 run.end{isError}→run.failed
      // 单源交付)——不合成,避免双投。缺省(run 外失败:队列派发/启动缺模型等)
      // 兜底合成。注:不用 isAgentRuntimeSessionActive——session 在 run 收尾
      // unregisterAbort 后才调 onError,判定恒 false(评审 Major-1)。
      if (options?.fromActiveRun !== true) {
        emitRuntimeEventNotification(input.threadId, createRunFailedRuntimeEvent(input.threadId, error), writeNotification);
      }
      input.onError?.(error);
    },
    onTitleUpdated: (title) =>
      writeNotification(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
        threadId: input.threadId,
        title
      }),
    onAskUserQuestion: (request) =>
      writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request),
    onDesktopActionRequest: (request) =>
      writeNotification(AGENT_IPC_CHANNELS.DESKTOP_ACTION_REQUEST, request),
    onToolPermissionRequest: (request) =>
      writeNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request)
  };
}

export function emitDiagnosticContent(
  input: Omit<SensitiveDiagnosticEnvelope, "schemaVersion" | "envelopeType" | "emittedAt" | "leaseVersion">
): void {
  const lease = getPersistedGeneralSettings().logging.diagnosticCapture;
  const notificationWriter = getOutboundNotificationWriter();
  if (!notificationWriter || !lease.enabled || !lease.expiresAt || Date.parse(lease.expiresAt) <= Date.now()) return;
  if (lease.scope?.threadId && input.threadId !== lease.scope.threadId) return;
  if (lease.scope?.traceId && input.traceId !== lease.scope.traceId) return;
  notificationWriter("system.diagnostic-content", {
    schemaVersion: 1,
    envelopeType: "sensitive-diagnostic",
    emittedAt: new Date().toISOString(),
    leaseVersion: lease.configVersion,
    ...input
  } satisfies SensitiveDiagnosticEnvelope);
}
