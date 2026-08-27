import type {
  LumeWorkflowHookContribution,
  LumeWorkflowHookEvent,
  LumeWorkflowHookHandlerRegistry
} from "./hook-events";
import type {
  LumeWorkflowHookEffectEnvelope,
  LumeWorkflowHookExecutionError,
  LumeWorkflowHookExecutionResult
} from "./hook-effects";
import { createRuntimeEventWorkflowHookService, createSecurityWorkflowHookService, createTraceWorkflowHookService } from "./hook-services";
import type { LumeWorkflowHookHandlerContext } from "./hook-services";

export class LumeWorkflowHookBus {
  constructor(private readonly input: {
    contributions: LumeWorkflowHookContribution[];
    handlers: LumeWorkflowHookHandlerRegistry;
    context?: LumeWorkflowHookHandlerContext;
    now?: () => Date;
  }) {}

  async execute(event: LumeWorkflowHookEvent): Promise<LumeWorkflowHookExecutionResult> {
    const effects: LumeWorkflowHookEffectEnvelope[] = [];
    const errors: LumeWorkflowHookExecutionError[] = [];
    for (const contribution of this.input.contributions) {
      if (!matchesContribution(contribution, event)) continue;
      const handler = this.input.handlers[contribution.handlerRef];
      if (!handler) {
        errors.push({ contributionId: contribution.id, message: "Handler not found." });
        continue;
      }
      try {
        const result = await handler(event, this.input.context ?? createNoopHookContext());
        for (const effect of result.effects) {
          effects.push({
            effect,
            sourceContributionId: contribution.id,
            pluginId: contribution.pluginId,
            createdAt: (this.input.now?.() ?? new Date()).toISOString()
          });
        }
        if (contribution.phase === "decision" && result.effects.some((effect) =>
          effect.type === "setPermissionDecision" && effect.decision === "deny"
        )) {
          break;
        }
      } catch (error) {
        errors.push({
          contributionId: contribution.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { effects, errors };
  }
}

function matchesContribution(
  contribution: LumeWorkflowHookContribution,
  event: LumeWorkflowHookEvent
): boolean {
  if (contribution.event !== event.event) return false;
  const selector = contribution.selector;
  if (!selector) return true;
  return selectorMatches(selector.toolName, "toolName" in event ? event.toolName : undefined)
    && selectorMatches(selector.permissionMode, event.permissionMode)
    && selectorMatches(selector.threadType, event.threadType)
    && selectorMatches(selector.chatType, event.chatType);
}

function selectorMatches(selector: string | string[] | undefined, value: string | undefined): boolean {
  if (selector === undefined) return true;
  if (value === undefined) return false;
  return Array.isArray(selector) ? selector.includes(value) : selector === value;
}

function createNoopHookContext(): LumeWorkflowHookHandlerContext {
  return {
    services: {
      memory: {
        recallContext: async (input) => ({
          prefix: "",
          items: [],
          userMessageForModel: input.userMessage
        }),
        extractCandidates: async () => []
      },
      security: createSecurityWorkflowHookService(),
      suggestion: {
        evaluateSessionSuggestions: async () => {}
      },
      persona: {
        ensurePersona: async () => {}
      },
      runtimeEvents: createRuntimeEventWorkflowHookService(),
      trace: createTraceWorkflowHookService(),
      clock: {
        now: () => new Date()
      }
    }
  };
}
