import { describe, expect, test } from "bun:test";
import { buildMemorySections } from "./memory-sections";

describe("memory-sections", () => {
  test("omits memory sections when memory tools are unavailable", () => {
    expect(buildMemorySections({ availableTools: new Set(["read"]) })).toEqual([]);
  });

  test("uses on-demand recall copy for memory search tools", () => {
    const sections = buildMemorySections({
      availableTools: new Set(["memory.search", "memory.read"]),
      citationsMode: "auto"
    });
    const prompt = sections.join("\n\n");

    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("Search memory when");
    expect(prompt).toContain("current shared work state");
    expect(prompt).toContain("what we are doing now");
    expect(prompt).toContain("make one compact memory.search call before answering");
    expect(prompt).toContain("what we were doing");
    expect(prompt).toContain("do not claim it is a fresh thread");
    expect(prompt).toContain("我们之前聊过这个话题");
    expect(prompt).toContain("Do not say \"从记忆中可以看出\"");
    expect(prompt).toContain("do not sound like a profile system");
    expect(prompt).toContain("instead of saying \"身份信息\"");
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
      availableTools: new Set(["memory.remember"])
    }).join("\n\n");

    expect(prompt).toContain("durable preference");
    expect(prompt).toContain("use memory.remember");
    expect(prompt).toContain("claim");
    expect(prompt).toContain("user/self");
    expect(prompt).toContain("assistant/self");
    expect(prompt).not.toContain("After completing any non-trivial task");
    expect(prompt).not.toContain("At natural conversation breakpoints");
    expect(prompt).not.toContain("## Memory Write Rules");
  });
});
