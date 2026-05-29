import { describe, expect, test } from "bun:test";
import {
  resolveSubagentCanAllowAlways,
  resolveSubagentPermissionPolicyDecision
} from "./subagent-permission-policy";

describe("subagent permission policy", () => {
  test("denies high-risk subagent approval requests when policy is deny-high-risk", () => {
    expect(resolveSubagentPermissionPolicyDecision({
      isSubagent: true,
      mode: "deny-high-risk",
      authorizationStatus: "approval_required",
      risk: "high",
      toolName: "Bash"
    })).toEqual({
      behavior: "deny",
      message: "Subagent 高风险工具已按策略拒绝: Bash",
      reasonCode: "subagent_high_risk_denied"
    });
  });

  test("does not deny parent runs or explicitly allowed tool executions", () => {
    expect(resolveSubagentPermissionPolicyDecision({
      isSubagent: false,
      mode: "deny-high-risk",
      authorizationStatus: "approval_required",
      risk: "high",
      toolName: "Bash"
    })).toBeNull();

    expect(resolveSubagentPermissionPolicyDecision({
      isSubagent: true,
      mode: "deny-high-risk",
      authorizationStatus: "allow",
      risk: "high",
      toolName: "Bash"
    })).toBeNull();
  });

  test("disables allow-always for subagent requests when policy disables it", () => {
    expect(resolveSubagentCanAllowAlways({
      isSubagent: true,
      allowAlways: "disabled",
      hasGrantSuggestion: true
    })).toBeFalse();
    expect(resolveSubagentCanAllowAlways({
      isSubagent: true,
      allowAlways: "desktop-only",
      hasGrantSuggestion: true
    })).toBeTrue();
    expect(resolveSubagentCanAllowAlways({
      isSubagent: false,
      allowAlways: "disabled",
      hasGrantSuggestion: true
    })).toBeTrue();
  });

  test("disables allow-always when no reusable grant is available", () => {
    expect(resolveSubagentCanAllowAlways({
      isSubagent: false,
      hasGrantSuggestion: false
    })).toBeFalse();
  });
});
