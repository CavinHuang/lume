import { AGENT_IPC_CHANNELS, type SensitiveDiagnosticEnvelope } from "@lume/shared";
import type { appendAgentMessage } from "./agent-service";
import { getPersistedGeneralSettings } from "../system/general-settings-service";
import { isAgentRuntimeSessionActive } from "../agent-runtime/runtime-core/attempt";

type AgentNotificationWriter = (method: string, params: unknown) => void;
type AgentStreamEmitter = Parameters<typeof appendAgentMessage>[1];

let notificationWriter: AgentNotificationWriter | null = null;

export function setAgentNotificationWriter(writer: AgentNotificationWriter): void {
  notificationWriter = writer;
}

export function emitAgentNotification(method: string, params: unknown): void {
  notificationWriter?.(method, params);
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
      writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
        threadId: eventThreadId,
        event
      });
    },
    onMessageAppended: (event) => {
      writeNotification(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, event);
      if (event.message.role !== "user" || typeof event.message.content !== "string") return;

      const createdAt = new Date(event.message.createdAt ?? Date.now()).toISOString();
      writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
        threadId: input.threadId,
        event: {
          id: `${input.threadId}:${event.message.id ?? createdAt}:message.user.submitted`,
          type: "message.user.submitted",
          runId: `message:${event.message.id ?? createdAt}`,
          threadId: input.threadId,
          text: event.message.content,
          createdAt,
          messageId: event.message.id,
          versionGroupId: event.message.versionGroupId,
          versionIndex: event.message.versionIndex,
          versionCount: event.message.versionCount,
          messageParts: event.message.metadata?.messageParts,
          capabilityReferences: event.message.metadata?.capabilityReferenceViews
        }
      });
    },
    onComplete: (payload) => input.onComplete?.(payload),
    onError: (error) => {
      // T7c 收编:活跃 run 的失败终值由事件总线 run.end{isError}→run.failed 单源交付,
      // 此处不再合成(避免双投);仅兜底无活跃 run 的 run 外失败(队列派发/规划启动等)。
      if (!isAgentRuntimeSessionActive(input.threadId)) {
        writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
          threadId: input.threadId,
          event: {
            id: `${input.threadId}:${Date.now()}:run.failed`,
            type: "run.failed",
            threadId: input.threadId,
            runId: `runtime-error:${input.threadId}`,
            createdAt: new Date().toISOString(),
            error: {
              code: "runtime_error",
              message: error
            }
          }
        });
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
