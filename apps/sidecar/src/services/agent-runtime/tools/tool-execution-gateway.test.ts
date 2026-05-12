import { describe, expect, test } from "bun:test";
import { ToolExecutionGateway } from "./tool-execution-gateway";
import type { LumeGuardrailRunner } from "../guardrails/guardrail-runner";

function guardrail(result: Awaited<ReturnType<LumeGuardrailRunner["runToolInputGuardrails"]>>): LumeGuardrailRunner {
  return {
    async runToolInputGuardrails() {
      return result;
    }
  } as unknown as LumeGuardrailRunner;
}

describe("ToolExecutionGateway", () => {
  test("denies plan-mode unsafe tools before running guardrails", async () => {
    let guardrailCalls = 0;
    const gateway = new ToolExecutionGateway({
      guardrails: {
        async runToolInputGuardrails() {
          guardrailCalls++;
          return { behavior: "allow" };
        }
      } as unknown as LumeGuardrailRunner
    });

    await expect(gateway.authorize({
      toolName: "Bash",
      input: { command: "echo hi" },
      permissionMode: "plan",
      context: { threadId: "thread-1" }
    })).resolves.toEqual({
      status: "deny",
      message: "当前是 plan 模式，只允许规划与只读工具，禁止执行: Bash"
    });
    expect(guardrailCalls).toBe(0);
  });

  test("denies rejected guardrail input before approval policy", async () => {
    const gateway = new ToolExecutionGateway({
      guardrails: guardrail({ behavior: "reject", reason: "blocked" })
    });

    await expect(gateway.authorize({
      toolName: "Write",
      input: { file_path: "../secret" },
      permissionMode: "bypassPermissions",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toEqual({
      status: "deny",
      message: "工具参数被拒绝: blocked"
    });
  });

  test("requires approval when guardrail asks for approval even in bypass mode", async () => {
    const gateway = new ToolExecutionGateway({
      guardrails: guardrail({ behavior: "require_approval", reason: "secret memory" })
    });

    await expect(gateway.authorize({
      toolName: "memory.remember",
      input: { content: "sk-secret" },
      permissionMode: "bypassPermissions",
      context: { threadId: "thread-1" }
    })).resolves.toEqual({
      status: "approval_required",
      reason: "secret memory",
      risk: "medium"
    });
  });
});
