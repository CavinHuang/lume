// #580:出站通知写入器单点注入。此前 agent/automation/desktop-context 三域
// 各自暴露 set*NotificationWriter 全局 setter(签名同型、注入值同源),
// 且 agent 域的注入藏在 rpc handler 工厂里;现合并为组合根一次注入。

export type OutboundNotificationWriter = (method: string, params: unknown) => void;

let writer: OutboundNotificationWriter | null = null;

export function setOutboundNotificationWriter(input: OutboundNotificationWriter): void {
  writer = input;
}

export function getOutboundNotificationWriter(): OutboundNotificationWriter | null {
  return writer;
}
