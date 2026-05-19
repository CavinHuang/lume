import type { AgentSendInput } from "@lume/shared";
import {
  buildDynamicContext,
  buildSystemPromptAppend
} from "../../agent/agent-prompt-builder";
import {
  resolveAgentDynamicContextInput,
  resolveAgentRuntimeRoutingTrace
} from "../../agent/agent-runtime-context";
import { createLogger } from "../../infra/logger";
import { resolveMemoryRuntimeConfig } from "../../memory/memory-policy";
import {
  buildMemoryV2UserMessageContext,
  type MemoryV2UserMessageContext
} from "../../memory-v2/user-message-prefix";
import type { MemoryV2RecallItem } from "../../memory-v2/types";
import { getPermissionDeniedSummary } from "../permissions/permission-denials";
import type { TraceRecorder } from "../trace/trace-recorder";
import { DEFAULT_CONTEXT_BUDGET, type ContextBudget } from "./context-budget";

export interface ContextAssemblyInput {
  threadId: string;
  runId: string;
  userMessage: string;
  cwd?: string;
  modelRef?: string;
  resolvedModelId: string;
  workspaceName?: string;
  workspaceSlug?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  agentSystemPrompt?: string;
  availableTools: string[];
  tokenBudget: number;
  trace?: {
    recorder: TraceRecorder;
    traceId: string;
    parentSpanId?: string;
  };
}

export interface ContextAssemblyResult {
  systemPrompt: string;
  dynamicContext: string;
  memoryContext: string;
  memoryUserMessagePrefix: string;
  memoryContextUsedItems: MemoryV2RecallItem[];
  userMessageForModel: string;
  sessionContext: string;
  planContext?: string;
  budget: ContextBudget;
  trace: {
    includedMemoryIds: string[];
    includedSessionMessageIds: string[];
    tokenUsageEstimate: number;
  };
}

const log = createLogger("agent-runtime-context-assembler");

export class ContextAssembler {
  async assemble(input: ContextAssemblyInput): Promise<ContextAssemblyResult> {
    if (input.trace) {
      const span = await input.trace.recorder.startSpan({
        traceId: input.trace.traceId,
        parentId: input.trace.parentSpanId,
        type: "context_assembly",
        name: "assemble prompt context",
        input: {
          threadId: input.threadId,
          workspaceSlug: input.workspaceSlug,
          availableTools: input.availableTools.length,
          tokenBudget: input.tokenBudget
        }
      });
      try {
        const result = await this.assembleWithoutContextSpan(input, span.id);
        await input.trace.recorder.endSpan(span.id, {
          budget: result.budget,
          tokenUsageEstimate: result.trace.tokenUsageEstimate
        });
        return result;
      } catch (error) {
        await input.trace.recorder.failSpan(span.id, error);
        throw error;
      }
    }
    return this.assembleWithoutContextSpan(input);
  }

  private async assembleWithoutContextSpan(
    input: ContextAssemblyInput,
    contextSpanId?: string
  ): Promise<ContextAssemblyResult> {
    const memoryRuntimeConfig = resolveMemoryRuntimeConfig();
    const systemPromptAppend = buildSystemPromptAppend({
      workspaceName: input.workspaceName,
      workspaceSlug: input.workspaceSlug,
      sessionId: input.threadId,
      sessionType: input.threadType,
      chatType: input.chatType,
      availableTools: input.availableTools,
      memoryCitationsMode: memoryRuntimeConfig.citationsMode,
      permissionMode: input.permissionMode
    }).trim();
    const agentSystemPrompt = input.agentSystemPrompt?.trim();

    const routingTrace = resolveAgentRuntimeRoutingTrace({
      workspaceSlug: input.workspaceSlug,
      userMessage: input.userMessage,
      availableTools: input.availableTools
    });
    log.debug("resolved capability routing trace", {
      sessionId: input.threadId,
      workspaceSlug: input.workspaceSlug,
      capabilityLanes: routingTrace.capabilityLanes,
      preferredCapabilityRoute: routingTrace.preferredCapabilityRoute,
      routingReason: routingTrace.reason
    });

    const dynamicContext = buildDynamicContext(
      resolveAgentDynamicContextInput({
        threadId: input.threadId,
        userMessage: input.userMessage,
        workspaceName: input.workspaceName,
        workspaceSlug: input.workspaceSlug,
        agentCwd: input.cwd ?? process.cwd(),
        availableTools: input.availableTools,
        threadType: input.threadType,
        chatType: input.chatType,
        fallbackModelRef: input.modelRef,
        fallbackModelId: input.modelRef ?? input.resolvedModelId
      })
    ).trim();
    const permissionDeniedContext = getPermissionDeniedSummary(input.threadId);

    let memoryContext: MemoryV2UserMessageContext = {
      prefix: "",
      items: [],
      userMessageForModel: input.userMessage
    };
    if (input.workspaceSlug && input.userMessage.trim()) {
      try {
        const memoryInput = {
          workspaceSlug: input.workspaceSlug,
          sessionType: resolvePromptMemorySessionType({
            threadType: input.threadType,
            chatType: input.chatType
          }),
          userMessage: input.userMessage,
          maxItems: 8
        };
        if (input.trace) {
          memoryContext = await input.trace.recorder.withSpan({
            traceId: input.trace.traceId,
            parentId: contextSpanId,
            type: "memory_retrieval",
            name: "build memory context",
            input: {
              workspaceSlug: memoryInput.workspaceSlug,
              sessionType: memoryInput.sessionType,
              maxItems: memoryInput.maxItems
            }
          }, () => buildMemoryV2UserMessageContext(memoryInput));
        } else {
          memoryContext = await buildMemoryV2UserMessageContext(memoryInput);
        }
      } catch (error) {
        log.warn("failed to build memory context", {
          sessionId: input.threadId,
          workspaceSlug: input.workspaceSlug,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const systemPrompt = [agentSystemPrompt, systemPromptAppend, dynamicContext, permissionDeniedContext]
      .filter((part) => typeof part === "string" && part.trim().length > 0)
      .join("\n\n");

    return {
      systemPrompt,
      dynamicContext,
      memoryContext: memoryContext.prefix,
      memoryUserMessagePrefix: memoryContext.prefix,
      memoryContextUsedItems: memoryContext.items,
      userMessageForModel: memoryContext.userMessageForModel,
      sessionContext: "",
      budget: {
        ...DEFAULT_CONTEXT_BUDGET,
        total: input.tokenBudget
      },
      trace: {
        includedMemoryIds: memoryContext.items.map((item) => item.id),
        includedSessionMessageIds: [],
        tokenUsageEstimate: estimateTokens(systemPrompt)
      }
    };
  }
}

function resolvePromptMemorySessionType(input: {
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
}): "main" | "subagent" | "group" | "channel" {
  if (input.threadType) return input.threadType;
  if (input.chatType === "group" || input.chatType === "channel") return input.chatType;
  return "main";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
