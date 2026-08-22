import {
  computeEffectiveRuntimeState,
  resolveSensitiveApproval,
  type SensitiveApprovalRecord,
  type SensitiveCapabilityKey,
} from "@lume/agent-sdk";
import type {
  FilePluginStateStore,
  PluginInstallRecord,
} from "./plugin-state-store.js";

export interface PluginPermissionRuntimeInput {
  stateStore: FilePluginStateStore;
}

export interface SensitiveCheckResult {
  decision: "allow" | "deny" | "ask";
  reason: string;
}

export interface RuntimeStateResult {
  state: "loaded" | "needs-review" | "not-loaded";
  reason: string;
}

/**
 * Source-bound permission gate (design spec §8.2, §14.2 Phase 2 skeleton).
 *
 * Reads plugin approval state from FilePluginStateStore and delegates the pure
 * decision logic to the SDK gate functions. Phase 2 only exposes the decision
 * API and unit-tests it; Phase 3's capability resolver is what calls
 * checkSensitiveCapability / computeRuntimeState during real loading.
 *
 * Source binding: every method is keyed by pluginId, so a plugin's permissions
 * never affect a different plugin's or a plain builtin tool's behavior.
 */
export class PluginPermissionRuntime {
  constructor(private readonly input: PluginPermissionRuntimeInput) {}

  async checkSensitiveCapability(params: {
    pluginId: string;
    key: SensitiveCapabilityKey;
    workspaceSlug?: string;
  }): Promise<SensitiveCheckResult> {
    const record = await this.loadRecord(params.pluginId);
    if (!record) {
      return { decision: "ask", reason: "no install or reviewed external state" };
    }
    // Approvals only count for the currently accepted permissions hash (#344):
    // an allow recorded under a hash the plugin has drifted away from must not
    // satisfy the same capability key after re-review. Empty hashes are treated
    // as wildcards for compatibility with pre-existing records.
    const currentHash = resolveAcceptedHash(record);
    const approvals = collectSensitiveApprovals(record).filter(
      (approval) =>
        approval.permissionsHash === "" || approval.permissionsHash === currentHash,
    );
    const decision = resolveSensitiveApproval(params.key, approvals, {
      workspaceSlug: params.workspaceSlug,
    });
    return {
      decision,
      reason:
        decision === "ask"
          ? approvals.some((a) => a.key === params.key)
            ? "prior approval is for a different permissions hash; re-review required"
            : "no prior approval for this capability"
          : `prior ${decision}`,
    };
  }

  async computeRuntimeState(params: {
    pluginId: string;
    enabled: boolean;
    currentHash: string;
  }): Promise<RuntimeStateResult> {
    const record = await this.loadRecord(params.pluginId);
    const hasReviewState = record !== undefined && hasAnyReviewState(record);
    const acceptedHash = record ? resolveAcceptedHash(record) : undefined;
    const result = computeEffectiveRuntimeState({
      hasReviewState,
      enabled: params.enabled,
      acceptedHash,
      currentHash: params.currentHash,
    });
    return { state: result.state, reason: result.reason };
  }

  /**
   * Persist a sensitive-capability approval/denial decision (Phase 4A interactive approval).
   * Delegates to FilePluginStateStore.appendSensitiveApproval, which writes to the same source
   * collectSensitiveApprovals reads so the next checkSensitiveCapability observes the record.
   */
  async appendSensitiveApproval(input: {
    pluginId: string;
    record: SensitiveApprovalRecord;
  }): Promise<void> {
    await this.input.stateStore.appendSensitiveApproval(input);
  }

  private async loadRecord(pluginId: string): Promise<PluginInstallRecord | undefined> {
    const state = await this.input.stateStore.read();
    return state.plugins[pluginId];
  }
}

function collectSensitiveApprovals(record: PluginInstallRecord): SensitiveApprovalRecord[] {
  const approvals: SensitiveApprovalRecord[] = [];
  if (record.activeVersion) {
    const version = record.versions[record.activeVersion];
    if (version) approvals.push(...version.sensitiveApprovals);
  }
  for (const external of Object.values(record.external ?? {})) {
    approvals.push(...external.sensitiveApprovals);
  }
  for (const bundle of Object.values(record.approvalsByHash)) {
    approvals.push(...bundle.sensitiveApprovals);
  }
  return approvals;
}

function hasAnyReviewState(record: PluginInstallRecord): boolean {
  if (record.activeVersion && record.versions[record.activeVersion]) return true;
  return Object.values(record.external ?? {}).some((e) => e.permissionsAcceptedAt !== undefined);
}

function resolveAcceptedHash(record: PluginInstallRecord): string | undefined {
  if (record.activeVersion) {
    const version = record.versions[record.activeVersion];
    if (version?.permissionsHash) return version.permissionsHash;
  }
  for (const external of Object.values(record.external ?? {})) {
    if (external.permissionsHash) return external.permissionsHash;
  }
  return undefined;
}
