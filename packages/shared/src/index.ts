/**
 * Root shared export surface.
 */

export * from "./types";
export * from "./agent";

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
