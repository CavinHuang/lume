import { describe, expect, test } from "bun:test";
import { inferCapabilityLanes } from "./capability-inventory";

describe("capability inventory", () => {
  test("reports available capability lanes without interpreting the user message", () => {
    expect(inferCapabilityLanes([
      "Skill",
      "browser",
      "memory.search",
      "web_search",
      "Read",
      "Write"
    ])).toEqual(["skills", "browser", "memory", "web", "raw-tools", "coding"]);
  });
});
