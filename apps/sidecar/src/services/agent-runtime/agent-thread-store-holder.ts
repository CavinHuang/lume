// apps/sidecar/src/services/agent-runtime/agent-thread-store-holder.ts
/**
 * 线程存储读写端口（#289 分层切边）。
 *
 * agent-runtime 内核多处需要读写线程元数据 / 消息，实现位于应用层
 * services/agent/agent-thread-manager。为避免内核反向依赖应用层，
 * 这里以进程级 holder 暴露最小端口，组装层（index.ts）在启动时安装；
 * 与 render-client-holder / browser-broker-holder 同一惯用法。
 *
 * 未注册即抛错：线程存储无合理的 no-op 缺省，静默缺省等于丢数据。
 */
import type { AgentMessage, AgentThreadMeta, SDKMessage } from "@lume/shared";

export type AgentThreadMetaUpdates = Partial<
  Pick<
    AgentThreadMeta,
    | "title"
    | "sdkThreadId"
    | "runtimeThreadId"
    | "workspaceId"
    | "fileContextId"
    | "source"
    | "pinned"
    | "parentThreadId"
    | "modelSelectionSource"
    | "status"
    | "trashedAt"
  >
>;

export interface AgentThreadCreateOptions {
  fileContextMode?: "newRoot" | "inherit" | "fork";
  fileContextId?: string;
  memoryProfile?: AgentThreadMeta["memoryProfile"];
  planningOperationId?: string;
  planningTodoId?: string;
}

export interface AgentThreadStorePort {
  getMeta(id: string): AgentThreadMeta | undefined;
  getMessages(id: string): AgentMessage[];
  getSdkMessages(id: string): SDKMessage[];
  /** 元数据条目缺失时返回 null 而非抛错（跨进程 read-modify-write 丢更新的容错写入）。 */
  tryUpdateMeta(id: string, updates: AgentThreadMetaUpdates): AgentThreadMeta | null;
  updateMeta(id: string, updates: AgentThreadMetaUpdates): AgentThreadMeta;
  createWithModelRef(
    title?: string,
    modelRef?: string,
    channelId?: string,
    workspaceId?: string,
    parentThreadId?: string,
    modelId?: string,
    options?: AgentThreadCreateOptions,
  ): AgentThreadMeta;
}

let store: AgentThreadStorePort | undefined;

/** 安装进程级线程存储实现（由应用组装层在启动时调用）。 */
export function registerAgentThreadStore(port: AgentThreadStorePort): void {
  store = port;
}

/** 读取线程存储端口；未注册说明调用早于组装层装配，属装配缺陷。 */
export function threadStore(): AgentThreadStorePort {
  if (!store) {
    throw new Error("AgentThreadStore 未注册：组装层需在启动时调用 registerAgentThreadStore");
  }
  return store;
}
