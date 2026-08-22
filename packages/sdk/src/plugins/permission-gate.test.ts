import { describe, expect, test } from "bun:test";
import {
  computeEffectiveRuntimeState,
  isHardDeniedTool,
  resolveSensitiveApproval,
  type SensitiveApprovalRecord,
} from "./permission-gate.js";

function record(
  key: SensitiveApprovalRecord["key"],
  partial: Partial<SensitiveApprovalRecord>,
): SensitiveApprovalRecord {
  return {
    key,
    scope: "global",
    decision: "allow",
    createdAt: "2026-01-01T00:00:00Z",
    permissionsHash: "h",
    ...partial,
  };
}

describe("resolveSensitiveApproval", () => {
  const key = "commandTool:echo" as const;

  test("returns ask when no prior record exists", () => {
    expect(resolveSensitiveApproval(key, [], { workspaceSlug: "ws" })).toBe("ask");
  });

  test("workspace deny beats workspace allow", () => {
    const records = [
      record(key, { scope: "workspace", workspaceSlug: "ws", decision: "allow" }),
      record(key, { scope: "workspace", workspaceSlug: "ws", decision: "deny" }),
    ];
    expect(resolveSensitiveApproval(key, records, { workspaceSlug: "ws" })).toBe("deny");
  });

  test("workspace allow beats global deny", () => {
    const records = [
      record(key, { scope: "global", decision: "deny" }),
      record(key, { scope: "workspace", workspaceSlug: "ws", decision: "allow" }),
    ];
    expect(resolveSensitiveApproval(key, records, { workspaceSlug: "ws" })).toBe("allow");
  });

  test("global deny beats global allow", () => {
    const records = [
      record(key, { scope: "global", decision: "allow" }),
      record(key, { scope: "global", decision: "deny" }),
    ];
    expect(resolveSensitiveApproval(key, records, { workspaceSlug: "ws" })).toBe("deny");
  });

  test("workspace record for a different workspace is ignored", () => {
    const records = [record(key, { scope: "workspace", workspaceSlug: "other", decision: "deny" })];
    expect(resolveSensitiveApproval(key, records, { workspaceSlug: "ws" })).toBe("ask");
  });
});

describe("isHardDeniedTool", () => {
  test("returns true for a tool in permissions.tools.deny", () => {
    expect(isHardDeniedTool({ tools: { deny: ["Bash"] } }, "Bash")).toBe(true);
  });

  test("returns false when deny list is absent or does not contain the tool", () => {
    expect(isHardDeniedTool({}, "Bash")).toBe(false);
    expect(isHardDeniedTool({ tools: { deny: ["Write"] } }, "Bash")).toBe(false);
  });
});

describe("computeEffectiveRuntimeState", () => {
  test("no review state => not-loaded", () => {
    expect(
      computeEffectiveRuntimeState({ hasReviewState: false, enabled: true, currentHash: "h" }),
    ).toEqual({ state: "not-loaded", reason: "no-review-state" });
  });

  test("reviewed but disabled => not-loaded", () => {
    expect(
      computeEffectiveRuntimeState({ hasReviewState: true, enabled: false, currentHash: "h" }),
    ).toEqual({ state: "not-loaded", reason: "disabled" });
  });

  test("enabled + accepted hash matches => loaded", () => {
    expect(
      computeEffectiveRuntimeState({
        hasReviewState: true,
        enabled: true,
        acceptedHash: "h",
        currentHash: "h",
      }),
    ).toEqual({ state: "loaded", reason: "loaded" });
  });

  test("enabled + hash mismatch => needs-review", () => {
    expect(
      computeEffectiveRuntimeState({
        hasReviewState: true,
        enabled: true,
        acceptedHash: "old",
        currentHash: "new",
      }),
    ).toEqual({ state: "needs-review", reason: "hash-mismatch" });
  });

  test("enabled + no accepted hash => needs-review", () => {
    expect(
      computeEffectiveRuntimeState({ hasReviewState: true, enabled: true, currentHash: "h" }),
    ).toEqual({ state: "needs-review", reason: "hash-mismatch" });
  });
});
