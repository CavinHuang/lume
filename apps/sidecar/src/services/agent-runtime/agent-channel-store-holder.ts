// apps/sidecar/src/services/agent-runtime/agent-channel-store-holder.ts
/**
 * 渠道存储读取端口（#289 分层切边）。
 *
 * 实现位于应用层 services/channel/channel-manager；内核经此 holder
 * 查询渠道与解析模型绑定，组装层（index.ts）启动时注入。
 * 与 agent-thread-store-holder / agent-workspace-store-holder 同惯用法。
 */
import type { Channel, ProviderApiFamily } from "@lume/shared";

export interface ChannelModelBinding {
  channel: Channel;
  modelId: string;
  family: ProviderApiFamily;
}

export interface AgentChannelStorePort {
  list(): Channel[];
  getById(id: string): Channel | undefined;
  isConnectionUsable(channel: Channel): boolean;
  decryptApiKey(channelId: string): string;
  resolveModelBinding(
    modelRef: string,
    capability?: "chat" | "embedding",
    preferredConnectionId?: string,
  ): ChannelModelBinding | null;
}

let store: AgentChannelStorePort | undefined;

/** 安装进程级渠道存储实现（由应用组装层在启动时调用）。 */
export function registerAgentChannelStore(port: AgentChannelStorePort): void {
  store = port;
}

/** 读取渠道存储端口；未注册说明调用早于组装层装配，属装配缺陷。 */
export function channelStore(): AgentChannelStorePort {
  if (!store) {
    throw new Error("AgentChannelStore 未注册：组装层需在启动时调用 registerAgentChannelStore");
  }
  return store;
}
