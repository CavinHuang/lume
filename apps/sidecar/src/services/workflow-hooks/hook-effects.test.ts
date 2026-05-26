import { describe, expect, test } from "bun:test";
import {
  collectAppendContextEffects,
  resolvePermissionDecision
} from "./hook-effects";

describe("workflow hook effects", () => {
  test("collects append context effects with source envelopes", () => {
    const effects = collectAppendContextEffects([{
      effect: {
        type: "appendContext",
        source: "hook:test",
        content: "<context>hello</context>"
      },
      sourceContributionId: "test.context",
      createdAt: "2026-05-26T00:00:00.000Z"
    }]);

    expect(effects).toEqual([{
      sourceContributionId: "test.context",
      source: "hook:test",
      content: "<context>hello</context>",
      hidden: false,
      usedMemoryItems: []
    }]);
  });

  test("permission decision prefers deny over ask and allow", () => {
    const decision = resolvePermissionDecision([
      {
        effect: { type: "setPermissionDecision", decision: "allow", reason: "known safe" },
        sourceContributionId: "allow",
        createdAt: "2026-05-26T00:00:00.000Z"
      },
      {
        effect: { type: "setPermissionDecision", decision: "deny", reason: "private root" },
        sourceContributionId: "deny",
        createdAt: "2026-05-26T00:00:00.000Z"
      }
    ]);

    expect(decision).toEqual({
      decision: "deny",
      reason: "private root",
      sourceContributionId: "deny"
    });
  });
});
