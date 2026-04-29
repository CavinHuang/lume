import { describe, expect, test } from "bun:test";
import { evaluateToolApprovalPolicy } from "./tool-policy";

describe("agent-runtime tool-policy", () => {
  test("allows bypass mode without approval", () => {
    expect(evaluateToolApprovalPolicy({
      permissionMode: "bypassPermissions",
      toolName: "Bash",
      guardrailResult: { behavior: "allow" }
    })).toEqual({ requiresApproval: false });
  });

  test("requires approval when guardrail asks for approval", () => {
    expect(evaluateToolApprovalPolicy({
      permissionMode: "bypassPermissions",
      toolName: "Bash",
      guardrailResult: {
        behavior: "require_approval",
        reason: "git push 需要确认"
      }
    })).toEqual({
      requiresApproval: true,
      reason: "git push 需要确认"
    });
  });

  test("acceptEdits allows write tools but still requires execute tools", () => {
    expect(evaluateToolApprovalPolicy({
      permissionMode: "acceptEdits",
      toolName: "Write",
      guardrailResult: { behavior: "allow" }
    })).toEqual({ requiresApproval: false });
    expect(evaluateToolApprovalPolicy({
      permissionMode: "acceptEdits",
      toolName: "Bash",
      guardrailResult: { behavior: "allow" }
    }).requiresApproval).toBeTrue();
  });
});
