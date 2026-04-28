import { describe, expect, test } from "bun:test";
import { composePromptSections } from "./section-composer";

describe("section-composer", () => {
  test("filters by mode and renders in priority order", () => {
    const prompt = composePromptSections([
      {
        id: "later",
        title: "Later",
        priority: 20,
        mode: ["full"],
        content: "B"
      },
      {
        id: "minimal",
        title: "Minimal",
        priority: 5,
        mode: ["minimal"],
        content: "skip"
      },
      {
        id: "first",
        title: "First",
        priority: 10,
        mode: ["full", "minimal"],
        content: "A"
      }
    ], "full");

    expect(prompt).toBe("## First\n\nA\n\n## Later\n\nB");
  });
});
