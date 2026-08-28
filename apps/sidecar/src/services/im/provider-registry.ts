import type { ImMirrorCarrier, ImProvider, ImAccountUpdateInput, ImPeerKind } from "@lume/shared";
import type { ImRuntimeAccount } from "./im-config-manager";
import type { InboundImRouteMessage } from "./im-message-router";

/**
 * 统一 worker 生命周期接口。微信的 processOnce 是 HTTP 长轮询的内部细节,不进此接口;
 * 事件驱动 worker(钉钉/飞书)在 start() 内建连接 + 注册回调,回调直接进 routeInboundImMessage。
 * runtime-manager 仅消费 start/stop/isRunning,从不调用 processOnce。
 */
export interface ImWorker {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export interface ImSendInput {
  account: ImRuntimeAccount;
  peerId: string;
  peerKind: ImPeerKind;
  text: string;
  contextToken?: string;
}

export interface ImSendMediaInput {
  account: ImRuntimeAccount;
  peerId: string;
  peerKind: ImPeerKind;
  contextToken?: string;
  mediaType: "image" | "video" | "file";
  fileData: Buffer;
  fileName: string;
  caption?: string;
}

export interface ImSendResult {
  ok: boolean;
  error?: string;
}

export interface ImCreateWorkerDeps {
  // routeMessage 失败会 reject：调用方要么 await（微信 cursor 语义）要么 .catch（WS 渠道）
  routeMessage?: (message: InboundImRouteMessage) => Promise<void>;
  updateAccount?: (id: string, input: ImAccountUpdateInput) => Promise<void> | void;
}

/**
 * #544 会话镜像能力位：只声明该渠道真正具备的写操作，上层（编排服务/RPC/UI）
 * 对缺省项一律不放行——「能力声明式」让各 provider 的平台差异收敛在自己文件内。
 */
export interface ImMirrorProviderCapabilities {
  /** 运行进度落到镜像群的载体形态 */
  carrier: ImMirrorCarrier;
  /** 建群（目标用户随建群一并入群）；缺省=无法主动建群（附着档只能附着既有群） */
  createGroup?: (input: {
    account: ImRuntimeAccount;
    name: string;
    userOpenId?: string;
  }) => Promise<{ ok: boolean; chatId?: string; error?: string }>;
  /** 同步群名（线程标题变更）；缺省=平台无改群名 API */
  renameGroup?: (input: {
    account: ImRuntimeAccount;
    chatId: string;
    name: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** 机器人退群（#544 裁决：线程删除固定退群、不解散）；缺省=平台无退群路径 */
  leaveGroup?: (input: {
    account: ImRuntimeAccount;
    chatId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}

export interface ImProviderDefinition {
  provider: ImProvider;
  createWorker: (account: ImRuntimeAccount, deps?: ImCreateWorkerDeps) => ImWorker;
  sendText: (input: ImSendInput) => Promise<ImSendResult>;
  sendMedia?: (input: ImSendMediaInput) => Promise<ImSendResult>;
  mirror?: ImMirrorProviderCapabilities;
}

const registry = new Map<ImProvider, ImProviderDefinition>();

export function registerImProvider(def: ImProviderDefinition): void {
  registry.set(def.provider, def);
}

export function getImProvider(provider: ImProvider): ImProviderDefinition {
  const def = registry.get(provider);
  if (!def) throw new Error(`未注册的 IM provider: ${provider}`);
  return def;
}

export function listRegisteredProviders(): ImProvider[] {
  return [...registry.keys()];
}
