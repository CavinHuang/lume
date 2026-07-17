import { describe, expect, test } from "bun:test";
import {
  expandRuntimeToolPolicyEntries,
  normalizeRuntimeToolPolicyEntry
} from "./tool-policy-matcher";

describe("tool-policy-matcher", () => {
  test("keeps plain web tools separate from Guanlan data-query tools", () => {
    expect(expandRuntimeToolPolicyEntries(["group:web"])).toEqual([
      "web_search",
      "web_fetch"
    ]);
    expect(expandRuntimeToolPolicyEntries(["group:data"])).toEqual([
      "guanlan_search",
      "guanlan_read",
      "guanlan_hotnews",
      "guanlan_research"
    ]);
  });

  test("expands product system tool groups used by settings", () => {
    expect(expandRuntimeToolPolicyEntries(["group:automation"])).toEqual([
      "cron_set",
      "automation_set"
    ]);
    expect(expandRuntimeToolPolicyEntries(["group:im"])).toEqual(["send_im_message"]);
    expect(expandRuntimeToolPolicyEntries(["group:reading"])).toContain("weread_search");
    expect(expandRuntimeToolPolicyEntries(["group:reading"])).toContain("weread_recommend");
    expect(expandRuntimeToolPolicyEntries(["group:reading"])).toContain("weread_reading_profile");
    expect(expandRuntimeToolPolicyEntries(["group:reading"])).toContain("weread_book_context");
  });

  test("normalizes Guanlan compact aliases", () => {
    expect(normalizeRuntimeToolPolicyEntry("guanlanSearch")).toBe("guanlan_search");
    expect(normalizeRuntimeToolPolicyEntry("guanlanRead")).toBe("guanlan_read");
    expect(normalizeRuntimeToolPolicyEntry("guanlanHotnews")).toBe("guanlan_hotnews");
    expect(normalizeRuntimeToolPolicyEntry("guanlanResearch")).toBe("guanlan_research");
  });
});
