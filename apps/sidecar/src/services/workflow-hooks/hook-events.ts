import type { MemoryV2RecallItem } from "../memory-v2/types";
import type { LumeRunItem } from "../agent-runtime/runner/run-items";
import type { LumeWorkflowHookEffect } from "./hook-effects";
import type { LumeWorkflowHookHandlerContext } from "./hook-services";

export type LumeWorkflowHookEventName =
  | "run.beforeStart"
  | "run.afterComplete"
  | "run.afterFailure"
  | "context.beforeAssemble"
  | "context.afterAssemble"
  | "permission.beforeDecision";

export type LumeWorkflowHookCapability =
  | "context.append"
  | "permission.decide"
  | "memory.enqueue"
  | "runtime.emit"
  | "trace.write";

export interface LumeWorkflowHookSelector {
  toolName?: string | string[];
  permissionMode?: string | string[];
  threadType?: string | string[];
  chatType?: string | string[];
}

export interface LumeWorkflowHookContribution {
  id: string;
  pluginId?: string;
  event: LumeWorkflowHookEventName;
  selector?: LumeWorkflowHookSelector;
  phase: "decision" | "observe";
  priority: "core" | "normal" | "late";
  capabilities: LumeWorkflowHookCapability[];
  handlerRef: string;
}

export interface LumeWorkflowHookBaseEvent {
  event: LumeWorkflowHookEventName;
  runId: string;
  threadId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  cwd: string;
  permissionMode?: string;
  threadType?: string;
  chatType?: string;
  messageMetadata?: Record<string, unknown>;
  modelRef?: string;
}

export interface LumeWorkflowRunBeforeStartEvent extends LumeWorkflowHookBaseEvent {
  event: "run.beforeStart";
  userMessage: string;
}

export interface LumeWorkflowRunAfterCompleteEvent extends LumeWorkflowHookBaseEvent {
  event: "run.afterComplete";
  userMessage: string;
  runStateSummary: {
    status: string;
    generatedItemCount: number;
    pendingInterruptionCount: number;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUSD?: number;
  };
  memoryContextUsedItems: MemoryV2RecallItem[];
  runItems?: LumeRunItem[];
}

export interface LumeWorkflowRunAfterFailureEvent extends LumeWorkflowHookBaseEvent {
  event: "run.afterFailure";
  userMessage: string;
  errorMessage: string;
}

export interface LumeWorkflowContextBeforeAssembleEvent extends LumeWorkflowHookBaseEvent {
  event: "context.beforeAssemble";
  userMessage: string;
  availableTools: string[];
  tokenBudget: number;
}

export interface LumeWorkflowContextAfterAssembleEvent extends LumeWorkflowHookBaseEvent {
  event: "context.afterAssemble";
  availableTools: string[];
  tokenBudget: number;
  memoryContextUsedItems: MemoryV2RecallItem[];
  userMessageForModelLength: number;
}

export interface LumeWorkflowPermissionBeforeDecisionEvent extends LumeWorkflowHookBaseEvent {
  event: "permission.beforeDecision";
  toolName: string;
  toolInputSummary: string;
  gatewayDecision: "allow" | "ask";
  risk?: string;
  reasonCode?: string;
}

export type LumeWorkflowHookEvent =
  | LumeWorkflowRunBeforeStartEvent
  | LumeWorkflowRunAfterCompleteEvent
  | LumeWorkflowRunAfterFailureEvent
  | LumeWorkflowContextBeforeAssembleEvent
  | LumeWorkflowContextAfterAssembleEvent
  | LumeWorkflowPermissionBeforeDecisionEvent;

export interface LumeWorkflowHookHandlerResult {
  effects: LumeWorkflowHookEffect[];
}

export type LumeWorkflowHookHandler = (
  event: LumeWorkflowHookEvent,
  context: LumeWorkflowHookHandlerContext
) => Promise<LumeWorkflowHookHandlerResult>;

export type LumeWorkflowHookHandlerRegistry = Record<string, LumeWorkflowHookHandler>;
