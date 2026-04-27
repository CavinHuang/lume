import { describe, expect, test } from "bun:test";
import { parseMarkdownMemoryItems } from "./memory-indexer";

describe("memory-indexer", () => {
  test("parseMarkdownMemoryItems 应将 Markdown section 映射为结构化记忆", () => {
    const items = parseMarkdownMemoryItems({
      workspaceSlug: "demo",
      path: "WORKSPACE.md",
      source: "memory",
      content: [
        "# WORKSPACE.md",
        "",
        "## Important Decisions",
        "- Adopt workspace journey memory instead of a full knowledge graph.",
        "",
        "## User Preferences in This Workspace",
        "- Keep memory visible, controllable, and auditable.",
        "",
        "## Open Questions",
        "- This section is intentionally ignored."
      ].join("\n")
    });

    expect(items).toEqual([
      expect.objectContaining({
        workspaceSlug: "demo",
        sourcePath: "WORKSPACE.md",
        scope: "workspace",
        kind: "decision",
        source: "memory",
        content: "Adopt workspace journey memory instead of a full knowledge graph.",
        importance: 4
      }),
      expect.objectContaining({
        workspaceSlug: "demo",
        sourcePath: "WORKSPACE.md",
        scope: "workspace",
        kind: "preference",
        source: "memory",
        content: "Keep memory visible, controllable, and auditable.",
        importance: 4
      })
    ]);
  });
});
