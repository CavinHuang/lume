import { describe, expect, test } from "bun:test";
import { buildMemorySections } from "./memory-sections";

describe("memory-sections", () => {
  test("omits memory sections when memory tools are unavailable", () => {
    expect(buildMemorySections({ availableTools: new Set(["read"]) })).toEqual([]);
  });

  test("uses on-demand recall copy for memory search tools", () => {
    const sections = buildMemorySections({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "auto"
    });
    const prompt = sections.join("\n\n");

    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("Search memory only when");
    expect(prompt).not.toContain("Before answering anything about prior work");
    expect(prompt).toContain("Citations:");
  });

  test("respects disabled memory citations", () => {
    const sections = buildMemorySections({
      availableTools: new Set(["memory.search"]),
      citationsMode: "off"
    });

    expect(sections.join("\n\n")).toContain("Citations are disabled");
  });

  test("write rules are durable-only and avoid task-by-task memory spam", () => {
    const prompt = buildMemorySections({
      availableTools: new Set(["memory.remember", "memory.writeEpisode"])
    }).join("\n\n");

    expect(prompt).toContain("durable preference");
    expect(prompt).toContain("meaningful collaboration episodes");
    expect(prompt).not.toContain("After completing any non-trivial task");
    expect(prompt).not.toContain("At natural conversation breakpoints");
    expect(prompt).not.toContain("## Memory Write Rules");
  });
});
