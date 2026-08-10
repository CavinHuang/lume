import type { MemoryV2Candidate, MemoryV2RecallItem } from "../memory-v2/types";
import { extractMemoryCandidatesWithLlm } from "../memory-v2/extraction";
import { enqueueBackgroundMemoryExtraction } from "../memory-v2/background-extractor";
import {
  buildMemoryV2UserMessageContext,
  type MemoryV2UserMessageContext
} from "../memory-v2/user-message-prefix";
import { ensurePersona } from "../memory-v2/persona";
import { evaluateSessionSuggestions, type SessionSuggestContext } from "../suggest/service";
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
  enqueueExtraction?(input: Parameters<typeof enqueueBackgroundMemoryExtraction>[0]): void;
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

/**
 * Proactive Suggestion 服务接口 —— hook handler 通过此抽象调用建议评估，
 * 便于测试注入 mock（与 memory/security 等服务同构）。
 *
 * `evaluateSessionSuggestions` 是 fire-and-forget 入口（service.ts:95），
 * service 内部已 fail-open；本接口仅做类型契约。
 */
export interface LumeWorkflowSuggestionService {
  evaluateSessionSuggestions(input: SessionSuggestContext): Promise<void>;
}

/**
 * Persona 服务接口 —— hook handler 通过此抽象调用 persona 合成，
 * 便于测试注入 mock（与 memory/suggestion 等服务同构）。
 *
 * `ensurePersona` 是 fail-open 入口（persona.ts），service 内部已 try/catch；
 * 本接口仅做类型契约。输入类型直接取自 ensurePersona 签名，保持忠实。
 */
export type LumeWorkflowPersonaInput = Parameters<typeof ensurePersona>[0];

export interface LumeWorkflowPersonaService {
  ensurePersona(input: LumeWorkflowPersonaInput): Promise<void>;
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
  suggestion: LumeWorkflowSuggestionService;
  persona: LumeWorkflowPersonaService;
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
      maxItems: 5,
      contextTokenBudget: contextInput.tokenBudget
    }) as Promise<MemoryV2UserMessageContext>,
    extractCandidates: async (candidateInput) => extractCandidates({
      text: candidateInput.userMessage,
      workspaceSlug: candidateInput.workspaceSlug
    }),
    enqueueExtraction: (candidateInput) => enqueueBackgroundMemoryExtraction(candidateInput)
  };
}

/**
 * 创建 Proactive Suggestion hook 服务。默认绑定 `evaluateSessionSuggestions`
 * （service.ts:95）；测试可注入 mock 以隔离 LLM / store 依赖。
 */
export function createSuggestionWorkflowHookService(input: {
  evaluate?: typeof evaluateSessionSuggestions;
} = {}): LumeWorkflowSuggestionService {
  const evaluate = input.evaluate ?? evaluateSessionSuggestions;
  return {
    evaluateSessionSuggestions: async (ctx) => evaluate(ctx)
  };
}

/**
 * 创建 Persona hook 服务。默认绑定 `ensurePersona`（persona.ts）；
 * 测试可注入 mock 以隔离 LLM / store 依赖。
 */
export function createPersonaWorkflowHookService(input: {
  ensure?: typeof ensurePersona;
} = {}): LumeWorkflowPersonaService {
  const ensure = input.ensure ?? ensurePersona;
  return {
    ensurePersona: async (ctx) => {
      await ensure(ctx);
    }
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
