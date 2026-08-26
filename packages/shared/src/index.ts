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
export * from "./runtime-error-copy";
export * from "./logging";

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
 * 单条 RPC 消息上限（#552）。合法最大 payload = 批量附件 50MB 原始 → ~66.7MB base64 + JSON 壳 ≈ 68MB，
 * 取 96MB 留余量。desktop 发送前用同一常量对称预检，超限本地 reject 而非干等 sidecar 超时。
 * 注意：JS 字符串 length 是 UTF-16 code unit 数；base64 主体下与字节数等价，JSON 壳含非 ASCII 时判定略松（方向安全）。
 */
export const MAX_RPC_MESSAGE_BYTES = 96 * 1024 * 1024;
