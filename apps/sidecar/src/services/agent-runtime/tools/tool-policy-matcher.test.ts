import { describe, expect, test } from "bun:test";
import {
  expandRuntimeToolPolicyEntries,
  normalizeRuntimeToolPolicyEntry
} from "./tool-policy-matcher";

describe("tool-policy-matcher", () => {
  test("expands the plain web tool group", () => {
    expect(expandRuntimeToolPolicyEntries(["group:web"])).toEqual([
      "web_search",
      "web_fetch"
    ]);
  });

  test("expands product system tool groups used by settings", () => {
    expect(expandRuntimeToolPolicyEntries(["group:automation"])).toEqual([
      "automation_set"
    ]);
    expect(expandRuntimeToolPolicyEntries(["group:im"])).toEqual(["send_im_message"]);
    expect(expandRuntimeToolPolicyEntries(["group:reading"])).toContain("weread_search");
    expect(expandRuntimeToolPolicyEntries(["group:reading"])).toContain("weread_recommend");
    expect(expandRuntimeToolPolicyEntries(["group:reading"])).toContain("weread_reading_profile");
    expect(expandRuntimeToolPolicyEntries(["group:reading"])).toContain("weread_book_context");
  });
});
