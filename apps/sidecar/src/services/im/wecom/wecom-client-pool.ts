import type { WSClient } from "@wecom/aibot-node-sdk";

/**
 * 企微出站连接池。
 *
 * 企微 SDK(@wecom/aibot-node-sdk)无 REST 出站,sendMessage 必须复用入站长连的 WSClient。
 * 故 worker 启动时把 wsClient 注册进池,出站 sendText 按 accountId 取出使用。
 */
const pool = new Map<string, WSClient>();

export function registerWecomClient(accountId: string, client: WSClient): void {
  pool.set(accountId, client);
}

export function unregisterWecomClient(accountId: string): void {
  pool.delete(accountId);
}

export function getWecomClient(accountId: string): WSClient | undefined {
  return pool.get(accountId);
}

/** 仅测试用:清空连接池,保证用例间隔离。 */
export function __clearWecomClientPoolForTests(): void {
  pool.clear();
}
