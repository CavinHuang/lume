import { defineTool, type ToolDefinition } from "@lume/agent-sdk";
import { updateCurrentStep } from "./plan-execution-controller";

export interface CreatePlanStepUpdateToolInput {
  sessionDir: string;
  threadId: string;
  now?: () => string;
  onPlanUpdated?: () => void | Promise<void>;
}

export function createPlanStepUpdateTool(input: CreatePlanStepUpdateToolInput): ToolDefinition {
  return defineTool({
    name: "PlanStepUpdate",
    description: "Report the structured result for the current running Lume plan step.",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string" },
        stepId: { type: "string" },
        status: { type: "string", enum: ["completed", "failed", "blocked"] },
        result: { type: "string" },
        error: { type: "string" }
      },
      required: ["planId", "stepId", "status"]
    },
    isReadOnly: true,
    isConcurrencySafe: false,
    async call(rawInput) {
      const record = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
      const planId = toNonEmptyString(record.planId);
      const stepId = toNonEmptyString(record.stepId);
      const status = normalizeStatus(record.status);
      if (!planId || !stepId || !status) {
        throw new Error("PlanStepUpdate 需要 planId、stepId 和有效 status");
      }
      const message = status === "failed"
        ? toNonEmptyString(record.error) ?? toNonEmptyString(record.result)
        : toNonEmptyString(record.result) ?? toNonEmptyString(record.error);
      const plan = await updateCurrentStep({
        sessionDir: input.sessionDir,
        threadId: input.threadId,
        planId
      }, {
        stepId,
        status,
        message,
        now: input.now
      });
      if (!plan) {
        throw new Error("找不到可更新的当前计划步骤");
      }
      await input.onPlanUpdated?.();
      return {
        data: {
          ok: true,
          planId,
          stepId,
          status
        }
      };
    }
  });
}

function normalizeStatus(value: unknown): "completed" | "failed" | "blocked" | undefined {
  return value === "completed" || value === "failed" || value === "blocked" ? value : undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
