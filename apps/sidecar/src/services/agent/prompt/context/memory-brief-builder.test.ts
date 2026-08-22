import { describe, expect, test } from "bun:test";
import { buildMemoryBrief } from "./memory-brief-builder";

describe("memory-brief-builder", () => {
  test("returns empty string when no memory content exists", () => {
    expect(buildMemoryBrief({})).toBe("");
  });

  test("builds durable and recent memory bullets without behavior instructions", () => {
    const brief = buildMemoryBrief({
      longTermMemory: "# MEMORY.md\n\n- User prefers concrete, direct implementation.\n- Avoid ornate prompt systems.",
      dailyMemory: "## 2026-04-27\n\n- Discussed Prompt Runtime.\n---\n- Discussed Prompt Runtime."
    });

    // 行为指令由静态 prompt「## 记忆」段单点声明，Brief 只承载数据
    expect(brief).not.toContain("Memory is shared experience");
    expect(brief).not.toContain("use memory search");
    expect(brief).toContain("长期：");
    expect(brief).toContain("- User prefers concrete, direct implementation.");
    expect(brief).toContain("- Avoid ornate prompt systems.");
    expect(brief).toContain("近期：");
    expect(brief.match(/Discussed Prompt Runtime/g)?.length).toBe(1);
    expect(brief).not.toContain("# MEMORY.md");
  });
});
