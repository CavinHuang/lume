import { describe, expect, test } from "bun:test";
import {
  AFTERGLOW_MARKER,
  isAfterglowLine,
  parseAfterglowBlocks,
  stripAfterglowLines
} from "./afterglow";

describe("afterglow protocol", () => {
  test("recognizes plain and list-prefixed afterglow lines", () => {
    expect(AFTERGLOW_MARKER).toBe("⟡");
    expect(isAfterglowLine("⟡ careful edge")).toEqual({ matched: true, text: "careful edge" });
    expect(isAfterglowLine("- ⟡ careful edge")).toEqual({ matched: true, text: "careful edge" });
    expect(isAfterglowLine("* ⟡ careful edge")).toEqual({ matched: true, text: "careful edge" });
    expect(isAfterglowLine("+ ⟡ careful edge")).toEqual({ matched: true, text: "careful edge" });
    expect(isAfterglowLine("text ⟡ careful edge")).toEqual({ matched: false });
  });

  test("splits markdown and afterglow blocks outside code fences", () => {
    expect(parseAfterglowBlocks([
      "First paragraph",
      "",
      "⟡ quiet judgment",
      "",
      "```ts",
      "⟡ const marker = true",
      "```",
      "",
      "Final paragraph"
    ].join("\n"))).toEqual([
      { type: "markdown", text: "First paragraph\n" },
      { type: "afterglow", text: "quiet judgment" },
      { type: "markdown", text: "\n```ts\n⟡ const marker = true\n```\n\nFinal paragraph" }
    ]);
  });

  test("strips afterglow while preserving fenced code", () => {
    const text = [
      "Answer",
      "⟡ remove me",
      "```md",
      "⟡ keep me",
      "```",
      "- ⟡ remove me too",
      "Done"
    ].join("\n");

    expect(stripAfterglowLines(text)).toBe([
      "Answer",
      "```md",
      "⟡ keep me",
      "```",
      "Done"
    ].join("\n"));
  });
});
