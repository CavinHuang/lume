import { describe, expect, test } from "bun:test";
import { getToolMetadata, isToolAllowedInPlanMode } from "./tool-metadata";

describe("tool-metadata", () => {
  test("classifies global memory mutations as high-risk writes", () => {
    expect(getToolMetadata("memory.promoteGlobal")).toMatchObject({
      category: "write",
      riskLevel: "high",
      allowedInPlanMode: false
    });
    expect(getToolMetadata("memory.rejectGlobalCandidate")).toMatchObject({
      category: "write",
      riskLevel: "high",
      allowedInPlanMode: false
    });
  });

  test("classifies automation mutations as high-risk writes and read/query as plan-safe", () => {
    expect(getToolMetadata("automation_set")).toMatchObject({
      category: "write",
      riskLevel: "high",
      allowedInPlanMode: false
    });
    expect(isToolAllowedInPlanMode("automation_read")).toBeTrue();
    expect(isToolAllowedInPlanMode("automation_query")).toBeTrue();
    expect(isToolAllowedInPlanMode("automation_set")).toBeFalse();
  });

  test("allows PlanWrite in plan mode without treating it as a risky write", () => {
    expect(getToolMetadata("PlanWrite")).toMatchObject({
      category: "control",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(isToolAllowedInPlanMode("PlanWrite")).toBeTrue();
  });

  test("treats PlanStepUpdate as a low-risk control tool", () => {
    expect(getToolMetadata("PlanStepUpdate")).toMatchObject({
      category: "control",
      riskLevel: "low"
    });
  });
});
