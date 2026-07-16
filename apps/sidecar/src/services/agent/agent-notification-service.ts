type AgentNotificationWriter = (method: string, params: unknown) => void;

let notificationWriter: AgentNotificationWriter | null = null;

export function setAgentNotificationWriter(writer: AgentNotificationWriter): void {
  notificationWriter = writer;
}

export function emitAgentNotification(method: string, params: unknown): void {
  notificationWriter?.(method, params);
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
import type { SensitiveDiagnosticEnvelope } from "@lume/shared";
import { getPersistedGeneralSettings } from "../system/general-settings-service";
