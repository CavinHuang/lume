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
    expect(getToolMetadata("weread_recommend")).toMatchObject({
      category: "network",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(getToolMetadata("weread_reading_profile")).toMatchObject({
      category: "network",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(getToolMetadata("weread_book_context")).toMatchObject({
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

  test("allows AskUserQuestion in plan mode for clarification before approval", () => {
    expect(getToolMetadata("AskUserQuestion")).toMatchObject({
      category: "control",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(isToolAllowedInPlanMode("AskUserQuestion")).toBeTrue();
  });

  test("treats automation_template as a write tool and keeps automation_list plan-safe", () => {
    // create 会创建真实定时 agent run，整工具取最保守值对齐 automation_set
    expect(getToolMetadata("automation_template")).toMatchObject({
      category: "write",
      riskLevel: "high",
      allowedInPlanMode: false
    });
    expect(isToolAllowedInPlanMode("automation_list")).toBeTrue();
  });

  test("treats automation_template as a write tool and keeps automation_list plan-safe", () => {
    // create 会创建真实定时 agent run，整工具取最保守值对齐 automation_set
    expect(getToolMetadata("automation_template")).toMatchObject({
      category: "write",
      riskLevel: "high",
      allowedInPlanMode: false
    });
    expect(isToolAllowedInPlanMode("automation_list")).toBeTrue();
  });

  test("describes UI personalization as a local write tool", () => {
    expect(getToolMetadata("personalize_ui")).toMatchObject({
      name: "personalize_ui",
      category: "write",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
  });

  test("classifies routine/suggestion/reading write tools explicitly", () => {
    expect(getToolMetadata("routine_read")).toMatchObject({
      category: "read",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(getToolMetadata("routine_trigger")).toMatchObject({
      category: "execute",
      riskLevel: "high",
      allowedInPlanMode: false
    });
    for (const name of ["routine_update", "routine_regenerate", "suggestion_analyze", "lume_reading_advance_progress", "lume_reading_pick_next"]) {
      expect(getToolMetadata(name)).toMatchObject({
        category: "write",
        riskLevel: "medium",
        allowedInPlanMode: false
      });
      expect(isToolAllowedInPlanMode(name)).toBeFalse();
    }
  });

  test("classifies web tools as low-risk plan-safe network reads", () => {
    for (const name of [
      "web_search",
      "web_fetch"
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
