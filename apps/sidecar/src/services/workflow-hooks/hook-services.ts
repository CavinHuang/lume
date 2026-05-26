import type { MemoryV2Candidate, MemoryV2RecallItem } from "../memory-v2/types";
import { extractMemoryCandidatesWithLlm } from "../memory-v2/extraction";
import {
  buildMemoryV2UserMessageContext,
  type MemoryV2UserMessageContext
} from "../memory-v2/user-message-prefix";
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

export function createMemoryWorkflowHookService(input: {
  buildUserMessageContext?: typeof buildMemoryV2UserMessageContext;
  extractCandidates?: typeof extractMemoryCandidatesWithLlm;
} = {}): LumeWorkflowMemoryService {
  const buildUserMessageContext = input.buildUserMessageContext ?? buildMemoryV2UserMessageContext;
  const extractCandidates = input.extractCandidates ?? extractMemoryCandidatesWithLlm;
  return {
    recallContext: async (contextInput) => buildUserMessageContext({
      workspaceSlug: contextInput.workspaceSlug,
      userMessage: contextInput.userMessage,
      sessionType: "main",
      maxItems: 8
    }) as Promise<MemoryV2UserMessageContext>,
    extractCandidates: async (candidateInput) => extractCandidates({
      text: candidateInput.userMessage,
      workspaceSlug: candidateInput.workspaceSlug
    })
  };
}

export function createSecurityWorkflowHookService(): LumeWorkflowSecurityService {
  return {
    evaluatePermissionDecision: async () => ({})
  };
}

export function createRuntimeEventWorkflowHookService(): LumeWorkflowRuntimeEventService {
  return {
    buildDiagnosticEvent: (input) => ({
      type: "workflow_hook.diagnostic",
      ...input
    })
  };
}

export function createTraceWorkflowHookService(): LumeWorkflowTraceService {
  return {
    buildHookTrace: (input) => ({
      type: "workflow_hook",
      ...input
    })
  };
}
