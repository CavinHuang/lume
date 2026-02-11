/**
 * Root shared export surface.
 */

export * from "./types";
export * from "./agent";

// Bootstrap-level compatibility types used by MIG-001 scaffold.
export type AppMode = "chat" | "agent";

export interface HealthcheckResult {
  ok: true;
  source: "desktop" | "web";
}
