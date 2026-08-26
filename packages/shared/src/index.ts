/**
 * Root shared export surface.
 */

export * from "./types";
export * from "./agent";
export * from "./agent-compaction";
export * from "./tool-names";
export * from "./afterglow";
export * from "./data/model-meta";
export * from "./data/catalog-mapping";
export * from "./browser-api-registry";
export * from "./agent-island-projections";
export * from "./coding-revert-summary";
export * from "./stable-serialize";

// Bootstrap-level compatibility types used by MIG-001 scaffold.
export type AppMode = "chat" | "agent";

export interface HealthcheckResult {
  ok: boolean;
  source: "desktop" | "web" | "sidecar";
  version?: number;
  error?: string;
}

/** 当前 IPC 协议版本，前后端必须一致 */
export const IPC_PROTOCOL_VERSION = 1;

/**
 * 单条进程间 RPC 消息上限（desktop↔sidecar 单源）。
 * 合法最大 payload = 批量附件 50MB 原始 → ~66.7MB base64 + JSON 壳 ≈ 68MB，取 96MB 留余量；
 * 防畸形超大行在 JSON.parse 前打爆内存。以 UTF-16 code unit 计——两侧均与
 * `payload.length`/`line.length` 对称比较，故非字节数不影响判定一致性。
 */
export const MAX_RPC_MESSAGE_BYTES = 96 * 1024 * 1024;
