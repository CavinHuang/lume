import { describe, expect, test } from "bun:test";
import {
  expandRuntimeToolPolicyEntries,
  normalizeRuntimeToolPolicyEntry
} from "./tool-policy-matcher";

describe("tool-policy-matcher", () => {
  test("keeps Guanlan tools in the web policy group", () => {
    expect(expandRuntimeToolPolicyEntries(["group:web"])).toEqual([
      "web_search",
      "web_fetch",
      "guanlan_search",
      "guanlan_read",
      "guanlan_hotnews",
      "guanlan_research"
    ]);
  });

  test("expands product system tool groups used by settings", () => {
    expect(expandRuntimeToolPolicyEntries(["group:automation"])).toEqual([
      "cron_read",
      "automation_read",
      "cron_set",
      "automation_set",
      "cron_query",
      "automation_query"
    ]);
    expect(expandRuntimeToolPolicyEntries(["group:im"])).toEqual(["send_im_message"]);
    expect(expandRuntimeToolPolicyEntries(["group:reading"])).toContain("weread_search");
  });

  test("normalizes Guanlan compact aliases", () => {
    expect(normalizeRuntimeToolPolicyEntry("guanlanSearch")).toBe("guanlan_search");
    expect(normalizeRuntimeToolPolicyEntry("guanlanRead")).toBe("guanlan_read");
    expect(normalizeRuntimeToolPolicyEntry("guanlanHotnews")).toBe("guanlan_hotnews");
    expect(normalizeRuntimeToolPolicyEntry("guanlanResearch")).toBe("guanlan_research");
  });
});
