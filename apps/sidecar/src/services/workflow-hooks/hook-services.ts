import type { MemoryV2Candidate, MemoryV2RecallItem } from "../memory-v2/types";
import type { LumeWorkflowHookEventName } from "./hook-events";
import type {
  LumeWorkflowRuntimeEventDraft,
  LumeWorkflowTraceRecord
} from "./hook-effects";

export interface LumeWorkflowMemoryRecallResult {
  prefix: string;
  items: MemoryV2RecallItem[];
  userMessageForModel: string;
}

export interface LumeWorkflowMemoryService {
  recallContext(input: {
    threadId: string;
    workspaceSlug?: string;
    userMessage: string;
    tokenBudget: number;
  }): Promise<LumeWorkflowMemoryRecallResult>;
  extractCandidates(input: {
    runId: string;
    threadId: string;
    workspaceSlug?: string;
    userMessage: string;
  }): Promise<MemoryV2Candidate[]>;
}

export interface LumeWorkflowSecurityService {
  evaluatePermissionDecision(input: {
    toolName: string;
    toolInputSummary: string;
    permissionMode?: string;
    gatewayDecision: "allow" | "ask";
    risk?: string;
    reasonCode?: string;
  }): Promise<{ decision?: "allow" | "ask" | "deny"; reason?: string }>;
}

export interface LumeWorkflowRuntimeEventService {
  buildDiagnosticEvent(input: {
    runId: string;
    threadId: string;
    contributionId: string;
    message: string;
    level: "debug" | "info" | "warning" | "error";
  }): LumeWorkflowRuntimeEventDraft;
}

export interface LumeWorkflowTraceService {
  buildHookTrace(input: {
    contributionId: string;
    event: LumeWorkflowHookEventName;
    status: "success" | "error" | "skipped";
    elapsedMs?: number;
    effectTypes?: string[];
    errorMessage?: string;
  }): LumeWorkflowTraceRecord;
}

export interface LumeWorkflowHookServices {
  memory: LumeWorkflowMemoryService;
  security: LumeWorkflowSecurityService;
  runtimeEvents: LumeWorkflowRuntimeEventService;
  trace: LumeWorkflowTraceService;
  clock: { now(): Date };
}

export interface LumeWorkflowHookHandlerContext {
  services: LumeWorkflowHookServices;
}
