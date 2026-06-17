/**
 * Plugin Audit Event types (Phase 4B core).
 *
 * Audit log records for plugin lifecycle + capability-gate decisions. Stored as
 * one JSON object per line in `~/.lume/plugins-audit.jsonl`. The 13-type union
 * is complete (includes FUTURE types that have no emitter yet) so the type layer
 * doesn't need to change when later hooks land.
 */

export type PluginAuditEventType =
  | "install"
  | "uninstall"
  | "enable"
  | "disable"
  | "permission_accept"
  | "sensitive_approval"
  | "sensitive_denial"
  | "needs_review"
  | "capability_blocked"
  | "diagnostic_recorded"
  | "mcp_start_failed"
  | "hook_filtered"
  | "command_tool_invalid";

export interface PluginAuditEvent {
  id: string;
  pluginId: string;
  version?: string;
  workspaceSlug?: string;
  type: PluginAuditEventType;
  createdAt: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface GetPluginAuditLogInput {
  pluginId: string;
  workspaceSlug?: string;
  limit?: number;
}

export interface GetPluginAuditLogResult {
  events: PluginAuditEvent[];
}
