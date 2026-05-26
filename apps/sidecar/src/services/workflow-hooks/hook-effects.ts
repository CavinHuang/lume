import type { MemoryV2Candidate, MemoryV2RecallItem } from "../memory-v2/types";
import type { LumeWorkflowHookEventName } from "./hook-events";

export interface AppendContextEffect {
  type: "appendContext";
  content: string;
  source: string;
  priority?: "early" | "normal" | "late";
  hidden?: boolean;
  usedMemoryItems?: MemoryV2RecallItem[];
  userMessageForModel?: string;
}

export interface SetPermissionDecisionEffect {
  type: "setPermissionDecision";
  decision: "allow" | "ask" | "deny";
  reason: string;
}

export interface LumeWorkflowRuntimeEventDraft {
  type: "workflow_hook.diagnostic";
  runId: string;
  threadId: string;
  contributionId: string;
  message: string;
  level: "debug" | "info" | "warning" | "error";
}

export interface EmitRuntimeEventEffect {
  type: "emitRuntimeEvent";
  event: LumeWorkflowRuntimeEventDraft;
}

export interface LumeWorkflowTraceRecord {
  type: "workflow_hook";
  contributionId: string;
  event: LumeWorkflowHookEventName;
  status: "success" | "error" | "skipped";
  elapsedMs?: number;
  effectTypes?: string[];
  errorMessage?: string;
}

export interface RecordTraceEffect {
  type: "recordTrace";
  record: LumeWorkflowTraceRecord;
}

export interface EnqueueMemoryCandidateEffect {
  type: "enqueueMemoryCandidate";
  candidates: MemoryV2Candidate[];
}

export type LumeWorkflowHookEffect =
  | AppendContextEffect
  | SetPermissionDecisionEffect
  | EmitRuntimeEventEffect
  | RecordTraceEffect
  | EnqueueMemoryCandidateEffect;

export interface LumeWorkflowHookEffectEnvelope {
  effect: LumeWorkflowHookEffect;
  sourceContributionId: string;
  pluginId?: string;
  createdAt: string;
}

export interface LumeWorkflowHookExecutionError {
  contributionId: string;
  message: string;
}

export interface LumeWorkflowHookExecutionResult {
  effects: LumeWorkflowHookEffectEnvelope[];
  errors: LumeWorkflowHookExecutionError[];
}

export interface CollectedAppendContextEffect {
  sourceContributionId: string;
  source: string;
  content: string;
  hidden: boolean;
  usedMemoryItems: MemoryV2RecallItem[];
  userMessageForModel?: string;
}

export interface ResolvedPermissionDecision {
  decision: "allow" | "ask" | "deny";
  reason: string;
  sourceContributionId: string;
}

export function collectAppendContextEffects(
  envelopes: LumeWorkflowHookEffectEnvelope[]
): CollectedAppendContextEffect[] {
  return envelopes
    .filter((envelope): envelope is LumeWorkflowHookEffectEnvelope & { effect: AppendContextEffect } =>
      envelope.effect.type === "appendContext")
    .map((envelope) => ({
      sourceContributionId: envelope.sourceContributionId,
      source: envelope.effect.source,
      content: envelope.effect.content,
      hidden: envelope.effect.hidden === true,
      usedMemoryItems: envelope.effect.usedMemoryItems ?? [],
      ...(envelope.effect.userMessageForModel
        ? { userMessageForModel: envelope.effect.userMessageForModel }
        : {})
    }));
}

export function resolvePermissionDecision(
  envelopes: LumeWorkflowHookEffectEnvelope[]
): ResolvedPermissionDecision | null {
  const decisions = envelopes.filter((envelope): envelope is LumeWorkflowHookEffectEnvelope & {
    effect: SetPermissionDecisionEffect;
  } => envelope.effect.type === "setPermissionDecision");
  const envelope = decisions.find((item) => item.effect.decision === "deny")
    ?? decisions.find((item) => item.effect.decision === "ask")
    ?? decisions.find((item) => item.effect.decision === "allow")
    ?? null;
  if (!envelope) return null;
  return {
    decision: envelope.effect.decision,
    reason: envelope.effect.reason,
    sourceContributionId: envelope.sourceContributionId
  };
}
