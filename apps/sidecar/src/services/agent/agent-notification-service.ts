type AgentNotificationWriter = (method: string, params: unknown) => void;

let notificationWriter: AgentNotificationWriter | null = null;

export function setAgentNotificationWriter(writer: AgentNotificationWriter): void {
  notificationWriter = writer;
}

export function emitAgentNotification(method: string, params: unknown): void {
  notificationWriter?.(method, params);
}
