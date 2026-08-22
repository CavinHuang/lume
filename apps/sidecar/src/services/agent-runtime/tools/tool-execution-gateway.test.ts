import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionGateway } from "./tool-execution-gateway";
import type { LumeGuardrailRunner } from "../guardrails/guardrail-runner";
import type { PermissionRuntime } from "../permissions/permission-runtime";
import type { LumeToolDescriptor } from "./tool-types";

function guardrail(result: Awaited<ReturnType<LumeGuardrailRunner["runToolInputGuardrails"]>>): LumeGuardrailRunner {
  return {
    async runToolInputGuardrails() {
      return result;
    }
  } as unknown as LumeGuardrailRunner;
}

function descriptor(overrides: Partial<LumeToolDescriptor> = {}): LumeToolDescriptor {
  return {
    name: "Bash",
    canonicalName: "bash",
    source: "sdk",
    definition: { name: "Bash" } as any,
    metadata: {
      category: "execute",
      capability: "shell",
      riskLevel: "medium",
      sideEffects: "external",
      allowedInPlanMode: false,
      isReadOnly: false,
      isConcurrencySafe: false,
      requiresApprovalByDefault: true
    },
    ...overrides
  };
}

describe("ToolExecutionGateway", () => {
  test("delegates permission decisions to PermissionRuntime", async () => {
    const gateway = new ToolExecutionGateway({
      guardrails: guardrail({ behavior: "allow" }),
      permissionRuntime: {
        async authorize() {
          return {
            status: "deny",
            reasonCode: "runtime_deny",
            riskLevel: "high",
            explanation: "runtime denied"
          };
        }
      } as Pick<PermissionRuntime, "authorize">
    });

    await expect(gateway.authorize({
      toolName: "Bash",
      descriptor: descriptor(),
      input: { command: "echo hi" },
      permissionMode: "default",
      context: { threadId: "thread-1" }
    })).resolves.toMatchObject({
      status: "deny",
      reasonCode: "runtime_deny",
      message: "runtime denied"
    });
  });

  test("forwards classifierEnabled into PermissionRuntime", async () => {
    const seenClassifierEnabled: unknown[] = [];
    const gateway = new ToolExecutionGateway({
      guardrails: guardrail({ behavior: "allow" }),
      permissionRuntime: {
        async authorize(input) {
          seenClassifierEnabled.push(input.classifierEnabled);
          return {
            status: "approval_required",
            reasonCode: "runtime_ask",
            riskLevel: "medium",
            explanation: "runtime asks"
          };
        }
      } as Pick<PermissionRuntime, "authorize">
    });

    await gateway.authorize({
      toolName: "Bash",
      descriptor: descriptor(),
      input: { command: "pwd" },
      permissionMode: "default",
      classifierEnabled: false,
      context: { threadId: "thread-1" }
    });

    expect(seenClassifierEnabled).toEqual([false]);
  });

  test("uses descriptor metadata as the approval source of truth", async () => {
    const gateway = new ToolExecutionGateway({
      guardrails: guardrail({ behavior: "allow" })
    });

    await expect(gateway.authorize({
      toolName: "external_read",
      descriptor: descriptor({
        name: "external_read",
        canonicalName: "external_read",
        source: "plugin",
        definition: { name: "external_read" } as any,
        metadata: {
          category: "read",
          capability: "skill",
          riskLevel: "low",
          sideEffects: "external",
          allowedInPlanMode: true,
          isReadOnly: true,
          isConcurrencySafe: true,
          requiresApprovalByDefault: false
        }
      }),
      input: {},
      permissionMode: "default",
      context: { threadId: "thread-1" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "metadata_low",
      risk: "low"
    });
  });

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
      descriptor: descriptor(),
      input: { command: "echo hi" },
      permissionMode: "plan",
      context: { threadId: "thread-1" }
    })).resolves.toMatchObject({
      status: "deny",
      message: "当前是 plan 模式，只允许规划与只读工具，禁止执行: Bash"
    });
    expect(guardrailCalls).toBe(0);
  });

  test("denies plan mode from descriptor metadata before running guardrails", async () => {
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
      toolName: "TaskReport",
      descriptor: descriptor({
        name: "TaskReport",
        canonicalName: "taskreport",
        source: "task",
        definition: { name: "TaskReport" } as any,
        metadata: {
          category: "control",
          capability: "planning",
          riskLevel: "low",
          sideEffects: "none",
          allowedInPlanMode: false,
          isReadOnly: false,
          isConcurrencySafe: false
        }
      }),
      input: {},
      permissionMode: "plan",
      context: { threadId: "thread-1" }
    })).resolves.toMatchObject({ status: "deny" });
    expect(guardrailCalls).toBe(0);
  });


  test("denies rejected guardrail input before approval policy", async () => {
    const gateway = new ToolExecutionGateway({
      guardrails: guardrail({ behavior: "reject", reason: "blocked" })
    });

    await expect(gateway.authorize({
      toolName: "Write",
      descriptor: descriptor({
        name: "Write",
        canonicalName: "write"
      }),
      input: { file_path: "../secret" },
      permissionMode: "bypassPermissions",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "deny",
      message: "工具参数被拒绝: blocked"
    });
  });

  test("bypasses confirmation guardrails while preserving hard rejects", async () => {
    const gateway = new ToolExecutionGateway({
      guardrails: guardrail({ behavior: "require_approval", reason: "secret memory" })
    });

    await expect(gateway.authorize({
      toolName: "memory.remember",
      descriptor: descriptor({
        name: "memory.remember",
        canonicalName: "memory.remember",
        metadata: {
          category: "write",
          capability: "memory",
          riskLevel: "medium",
          sideEffects: "external",
          allowedInPlanMode: false,
          isReadOnly: false,
          isConcurrencySafe: false,
          requiresApprovalByDefault: true
        }
      }),
      input: { content: "sk-secret" },
      permissionMode: "bypassPermissions",
      context: { threadId: "thread-1" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "bypass_guardrail_confirmation",
      risk: "medium"
    });
  });
});
