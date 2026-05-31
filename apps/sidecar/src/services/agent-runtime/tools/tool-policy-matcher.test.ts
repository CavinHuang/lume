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

  test("normalizes Guanlan compact aliases", () => {
    expect(normalizeRuntimeToolPolicyEntry("guanlanSearch")).toBe("guanlan_search");
    expect(normalizeRuntimeToolPolicyEntry("guanlanRead")).toBe("guanlan_read");
    expect(normalizeRuntimeToolPolicyEntry("guanlanHotnews")).toBe("guanlan_hotnews");
    expect(normalizeRuntimeToolPolicyEntry("guanlanResearch")).toBe("guanlan_research");
  });
});
