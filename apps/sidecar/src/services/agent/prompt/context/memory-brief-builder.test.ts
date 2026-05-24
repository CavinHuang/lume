import { describe, expect, test } from "bun:test";
import { buildMemoryBrief } from "./memory-brief-builder";

describe("memory-brief-builder", () => {
  test("returns empty string when no memory content exists", () => {
    expect(buildMemoryBrief({})).toBe("");
  });

  test("builds durable and recent memory bullets without headings", () => {
    const brief = buildMemoryBrief({
      longTermMemory: "# MEMORY.md\n\n- User prefers concrete, direct implementation.\n- Avoid ornate prompt systems.",
      dailyMemory: "## 2026-04-27\n\n- Discussed Prompt Runtime.\n---\n- Discussed Prompt Runtime."
    });

    expect(brief).toContain("Memory is shared experience, not a dossier.");
    expect(brief).toContain("current shared work state");
    expect(brief).toContain("Do not treat a new thread as a new relationship");
    expect(brief).toContain("Durable:");
    expect(brief).toContain("- User prefers concrete, direct implementation.");
    expect(brief).toContain("- Avoid ornate prompt systems.");
    expect(brief).toContain("Recent:");
    expect(brief.match(/Discussed Prompt Runtime/g)?.length).toBe(1);
    expect(brief).not.toContain("# MEMORY.md");
  });
});
