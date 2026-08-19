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

  test("keeps TaskReport out of plan mode", () => {
    expect(getToolMetadata("TaskReport")).toMatchObject({
      category: "control",
      riskLevel: "low",
      allowedInPlanMode: false
    });
    expect(isToolAllowedInPlanMode("TaskReport")).toBeFalse();
  });

  test("describes UI personalization as a local write tool", () => {
    expect(getToolMetadata("personalize_ui")).toMatchObject({
      name: "personalize_ui",
      category: "write",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
  });

  test("classifies Office validation as a low-risk read tool", () => {
    expect(getToolMetadata("office_validate")).toMatchObject({
      name: "office_validate",
      category: "read",
      riskLevel: "low",
      allowedInPlanMode: true
    });
    expect(getToolMetadata("office_unpack")).toMatchObject({
      name: "office_unpack",
      category: "write",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
    expect(getToolMetadata("office_pack")).toMatchObject({
      name: "office_pack",
      category: "write",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
  });

  test("classifies remaining office tools explicitly (名称推断漏网收口)", () => {
    expect(getToolMetadata("office_convert")).toMatchObject({
      category: "execute",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
    for (const name of [
      "office_clean",
      "docx_create",
      "pptx_create",
      "xlsx_create",
      "pdf_create",
      "docx_comment",
      "pptx_add_slide",
      "xlsx_recalc",
      "pdf_tools",
      "office_extract_style",
      "office_thumbnail",
      "office_accept_changes"
    ]) {
      expect(getToolMetadata(name)).toMatchObject({
        category: "write",
        riskLevel: "medium",
        allowedInPlanMode: false
      });
      expect(isToolAllowedInPlanMode(name)).toBeFalse();
    }
    expect(getToolMetadata("info_extract")).toMatchObject({
      category: "read",
      riskLevel: "low",
      allowedInPlanMode: true
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
