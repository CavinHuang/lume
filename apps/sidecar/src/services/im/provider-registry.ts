import type { ImProvider, ImAccountUpdateInput, ImPeerKind } from "@lume/shared";
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
  routeMessage?: (message: InboundImRouteMessage) => Promise<void> | void;
  updateAccount?: (id: string, input: ImAccountUpdateInput) => Promise<void> | void;
}

export interface ImProviderDefinition {
  provider: ImProvider;
  createWorker: (account: ImRuntimeAccount, deps?: ImCreateWorkerDeps) => ImWorker;
  sendText: (input: ImSendInput) => Promise<ImSendResult>;
  sendMedia?: (input: ImSendMediaInput) => Promise<ImSendResult>;
  createLoginManager?: () => unknown;
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
