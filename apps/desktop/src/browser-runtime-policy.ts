import type { BrowserRequestContext } from "../../../packages/shared/src/types/browser-runtime"

export type BrowserSessionKind = "shared" | "agent-task" | "advanced-cdp"

export function selectBrowserSessionKind(context: BrowserRequestContext, params: Record<string, unknown>): BrowserSessionKind {
  if (params.sessionKind === "advanced-cdp") return "advanced-cdp"
  if (context.actor === "agent" && params.sessionKind === "agent-task") return "agent-task"
  return "shared"
}

export function selectBrowserPartition(context: BrowserRequestContext, params: Record<string, unknown>): string {
  const kind = selectBrowserSessionKind(context, params)
  if (kind === "shared") return "persist:lume-browser"
  const session = safePartitionPart(context.browserSessionId)
  const turn = safePartitionPart(context.browserTurnId)
  return `${kind === "advanced-cdp" ? "lume-cdp" : "lume-agent"}-${session}-${turn}`
}

export function shouldInstallAgentSessionPolicy(partition: string): boolean {
  return partition.startsWith("lume-agent-")
}

export function shouldInstallAdvancedCdpPolicy(partition: string): boolean {
  return partition.startsWith("lume-cdp-")
}

function safePartitionPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "session"
}
