import { describe, expect, test } from "bun:test";
import { getToolMetadata, isToolAllowedInPlanMode } from "./tool-metadata";

describe("tool-metadata", () => {
  test("classifies Memory V2 writes as medium-risk writes", () => {
    expect(getToolMetadata("memory.remember")).toMatchObject({
      category: "write",
      riskLevel: "medium",
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

  test("classifies Reading tools by read/write risk", () => {
    expect(getToolMetadata("lume_reading_snapshot")).toMatchObject({
      category: "read",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(getToolMetadata("weread_search")).toMatchObject({
      category: "network",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(getToolMetadata("weread_best_bookmarks")).toMatchObject({
      category: "network",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(getToolMetadata("lume_revise_reading_note")).toMatchObject({
      category: "write",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
    expect(getToolMetadata("lume_write_reading_note")).toMatchObject({
      category: "write",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
    expect(getToolMetadata("lume_generate_share_card")).toMatchObject({
      category: "write",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
    expect(getToolMetadata("weread_generate_note")).toMatchObject({
      category: "write",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
    expect(getToolMetadata("weread_export_all_notes")).toMatchObject({
      category: "write",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
  });

  test("allows TaskContractWrite in plan mode without treating it as a risky write", () => {
    expect(getToolMetadata("TaskContractWrite")).toMatchObject({
      category: "control",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(isToolAllowedInPlanMode("TaskContractWrite")).toBeTrue();
  });

  test("allows AskUserQuestion in plan mode for clarification before approval", () => {
    expect(getToolMetadata("AskUserQuestion")).toMatchObject({
      category: "control",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(isToolAllowedInPlanMode("AskUserQuestion")).toBeTrue();
  });

  test("keeps TaskReport out of plan mode", () => {
    expect(getToolMetadata("TaskReport")).toMatchObject({
      category: "control",
      riskLevel: "low",
      allowedInPlanMode: false
    });
    expect(isToolAllowedInPlanMode("TaskReport")).toBeFalse();
  });

  test("classifies Guanlan tools as low-risk plan-safe network reads", () => {
    for (const name of [
      "guanlan_search",
      "guanlan_read",
      "guanlan_hotnews",
      "guanlan_research"
    ]) {
      expect(getToolMetadata(name)).toMatchObject({
        category: "network",
        riskLevel: "low",
        allowedInPlanMode: true
      });
      expect(isToolAllowedInPlanMode(name)).toBeTrue();
    }
  });
});
