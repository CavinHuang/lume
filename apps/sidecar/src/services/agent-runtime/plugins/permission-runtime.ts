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
    const approvals = collectSensitiveApprovals(record);
    const decision = resolveSensitiveApproval(params.key, approvals, {
      workspaceSlug: params.workspaceSlug,
    });
    return {
      decision,
      reason: decision === "ask" ? "no prior approval for this capability" : `prior ${decision}`,
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
