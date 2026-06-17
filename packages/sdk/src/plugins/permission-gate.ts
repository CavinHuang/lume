import type { PluginPermissions } from "./manifest.js";

/**
 * Deterministic key for a sensitive capability requiring first-run approval.
 * See design spec §16.4.
 */
export type SensitiveCapabilityKey =
  | `commandTool:${string}`
  | `mcpServer:${string}`
  | `hook:${string}:${string}`
  | `network:${string}`
  | `filesystem:write:${string}`
  | `tool:${string}`;

/**
 * A recorded approval/denial for a sensitive capability key.
 * Stored in PluginInstallRecord.sensitiveApprovals (Phase 2 tightens the store
 * type to use this shape).
 */
export interface SensitiveApprovalRecord {
  key: SensitiveCapabilityKey;
  scope: "global" | "workspace";
  workspaceSlug?: string;
  decision: "allow" | "deny";
  createdAt: string;
  permissionsHash: string;
}

export type SensitiveDecision = "allow" | "deny" | "ask";

/**
 * Resolve a sensitive capability against prior approval records per spec §16.4.
 *
 * Priority: workspace deny > workspace allow > global deny > global allow > ask.
 * Workspace records only match when workspaceSlug equals the record's workspaceSlug.
 */
export function resolveSensitiveApproval(
  key: SensitiveCapabilityKey,
  records: SensitiveApprovalRecord[],
  context: { workspaceSlug?: string },
): SensitiveDecision {
  const workspaceSlug = context.workspaceSlug;

  const workspaceDeny = records.find(
    (r) =>
      r.key === key &&
      r.scope === "workspace" &&
      r.workspaceSlug === workspaceSlug &&
      r.decision === "deny",
  );
  if (workspaceDeny) return "deny";

  const workspaceAllow = records.find(
    (r) =>
      r.key === key &&
      r.scope === "workspace" &&
      r.workspaceSlug === workspaceSlug &&
      r.decision === "allow",
  );
  if (workspaceAllow) return "allow";

  const globalDeny = records.find((r) => r.key === key && r.scope === "global" && r.decision === "deny");
  if (globalDeny) return "deny";

  const globalAllow = records.find((r) => r.key === key && r.scope === "global" && r.decision === "allow");
  if (globalAllow) return "allow";

  return "ask";
}

/**
 * Hard-deny check for manifest-declared `permissions.tools.deny`.
 * Hard deny cannot be overridden by bypassPermissions (enforced by callers,
 * spec §8.2). A tool on the deny list is blocked unconditionally.
 */
export function isHardDeniedTool(permissions: PluginPermissions, toolName: string): boolean {
  const deny = permissions.tools?.deny ?? [];
  return deny.includes(toolName);
}

export type EffectiveRuntimeState = "loaded" | "needs-review" | "not-loaded";

export interface EffectiveRuntimeStateInput {
  /** An install record or reviewed external state exists for this plugin. */
  hasReviewState: boolean;
  /** Effective config (global + workspace) enables this plugin. */
  enabled: boolean;
  /** Accepted permissions hash, if any (from approvalsByHash / version / external). */
  acceptedHash?: string;
  /** Current permissions hash of the on-disk plugin (computePermissionsHash). */
  currentHash: string;
}

/**
 * Compute the effective runtime load state per spec §16.5 table.
 * Phase 2 uses this to label each listed plugin; Phase 3's capability resolver
 * gates actual loading on `state === "loaded"`.
 */
export function computeEffectiveRuntimeState(
  input: EffectiveRuntimeStateInput,
): { state: EffectiveRuntimeState; reason: "no-review-state" | "disabled" | "loaded" | "hash-mismatch" } {
  if (!input.hasReviewState) {
    return { state: "not-loaded", reason: "no-review-state" };
  }
  if (!input.enabled) {
    return { state: "not-loaded", reason: "disabled" };
  }
  if (input.acceptedHash !== undefined && input.acceptedHash === input.currentHash) {
    return { state: "loaded", reason: "loaded" };
  }
  return { state: "needs-review", reason: "hash-mismatch" };
}
