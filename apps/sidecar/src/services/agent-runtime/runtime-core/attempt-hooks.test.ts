import { describe, expect, test } from "bun:test";
import { resolveWorkflowPermissionHookResult } from "./attempt";

const event = {
  event: "permission.beforeDecision" as const,
  runId: "run-1",
  threadId: "thread-1",
  cwd: "/tmp/project",
  toolName: "Bash",
  toolInputSummary: "rm -rf .lume",
  gatewayDecision: "ask" as const
};

describe("workflow permission hook decision", () => {
  test("denies before interactive approval", async () => {
    const result = await resolveWorkflowPermissionHookResult({
      workflowHooks: {
        execute: async () => ({
          effects: [{
            effect: { type: "setPermissionDecision", decision: "deny", reason: "private root" },
            sourceContributionId: "core.security.permission",
            createdAt: "2026-05-26T00:00:00.000Z"
          }],
          errors: []
        })
      },
      event
    });

    expect(result).toEqual({ behavior: "deny", message: "private root" });
  });

  test("allows before ordinary ask approval", async () => {
    const result = await resolveWorkflowPermissionHookResult({
      workflowHooks: {
        execute: async () => ({
          effects: [{
            effect: { type: "setPermissionDecision", decision: "allow", reason: "trusted command" },
            sourceContributionId: "core.security.permission",
            createdAt: "2026-05-26T00:00:00.000Z"
          }],
          errors: []
        })
      },
      event
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  test("falls back to ask for ask, disabled, missing runtime, no decision, returned errors, and thrown errors", async () => {
    const explicitAsk = await resolveWorkflowPermissionHookResult({
      workflowHooks: {
        execute: async () => ({
          effects: [{
            effect: { type: "setPermissionDecision", decision: "ask", reason: "review" },
            sourceContributionId: "core.security.permission",
            createdAt: "2026-05-26T00:00:00.000Z"
          }],
          errors: []
        })
      },
      event
    });
    const disabled = await resolveWorkflowPermissionHookResult({ disabled: true, workflowHooks: {} as never, event });
    const missingRuntime = await resolveWorkflowPermissionHookResult({ event });
    const noDecision = await resolveWorkflowPermissionHookResult({
      workflowHooks: { execute: async () => ({ effects: [], errors: [] }) },
      event
    });
    const returnedErrors = await resolveWorkflowPermissionHookResult({
      workflowHooks: {
        execute: async () => ({ effects: [], errors: [{ contributionId: "x", message: "boom" }] })
      },
      event
    });
    const thrown = await resolveWorkflowPermissionHookResult({
      workflowHooks: {
        execute: async () => {
          throw new Error("boom");
        }
      },
      event
    });

    expect([explicitAsk, disabled, missingRuntime, noDecision, returnedErrors, thrown]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null
    ]);
  });
});
