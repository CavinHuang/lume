export type AppMode = "chat" | "agent";

export interface HealthcheckResult {
  ok: true;
  source: "desktop" | "web";
}

