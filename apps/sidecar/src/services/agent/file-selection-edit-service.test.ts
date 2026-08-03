import { describe, expect, test } from "bun:test";
import { buildSelectionEditPrompt } from "./file-selection-edit-service";

describe("buildSelectionEditPrompt", () => {
  test("marks the exact selection and keeps surrounding file context", () => {
    const content = "const before = 1;\r\nconst selected = 2;\r\nconst after = 3;\r\n";
    const selectedText = "const selected = 2;";
    const startOffset = content.indexOf(selectedText);
    const prompt = buildSelectionEditPrompt({
      ref: { source: "project", scopeId: "workspace", relativePath: "src/demo.ts" },
      content,
      startOffset,
      endOffset: startOffset + selectedText.length,
      instruction: "Use a descriptive name.",
    });

    expect(prompt).toContain("File: src/demo.ts");
    expect(prompt).toContain(`<selected_text>\n${selectedText}\n</selected_text>`);
    expect(prompt).toContain("const before = 1;");
    expect(prompt).toContain("const after = 3;");
    expect(prompt).toContain("<user_instruction>\nUse a descriptive name.\n</user_instruction>");
  });

  test("caps the surrounding excerpt without truncating the selection", () => {
    const before = "a".repeat(200_000);
    const selectedText = "selected";
    const after = "b".repeat(200_000);
    const content = before + selectedText + after;
    const prompt = buildSelectionEditPrompt({
      ref: { source: "session", scopeId: "thread", relativePath: "large.txt" },
      content,
      startOffset: before.length,
      endOffset: before.length + selectedText.length,
      instruction: "Uppercase it.",
    });

    expect(prompt).toContain(`<selected_text>\n${selectedText}\n</selected_text>`);
    expect(prompt.length).toBeLessThan(129 * 1024);
  });
});
