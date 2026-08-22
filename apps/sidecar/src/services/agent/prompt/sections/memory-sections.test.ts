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

    expect(prompt).toContain("## 记忆");
    expect(prompt).toContain("再搜索记忆");
    expect(prompt).toContain("当前协作状态");
    expect(prompt).toContain("我们在做什么");
    expect(prompt).toContain("先做一次紧凑的 memory.search 再回答");
    expect(prompt).toContain("不要宣称这是全新线程");
    expect(prompt).toContain("我们之前聊过这个话题");
    expect(prompt).toContain("不要说\"从记忆中可以看出\"");
    expect(prompt).toContain("不要像档案系统一样说话");
    expect(prompt).toContain("不要说\"身份信息\"");
    expect(prompt).not.toContain("Before answering anything about prior work");
    expect(prompt).toContain("引用：");
  });

  test("respects disabled memory citations", () => {
    const sections = buildMemorySections({
      availableTools: new Set(["memory.search"]),
      citationsMode: "off"
    });

    expect(sections.join("\n\n")).toContain("引用已关闭");
  });

  test("write rules are durable-only and avoid task-by-task memory spam", () => {
    const prompt = buildMemorySections({
      availableTools: new Set(["memory.remember"])
    }).join("\n\n");

    expect(prompt).toContain("持久身份事实、偏好");
    expect(prompt).toContain("使用 memory.remember");
    expect(prompt).toContain("claim");
    expect(prompt).toContain("user/self");
    expect(prompt).toContain("assistant/self");
    expect(prompt).not.toContain("After completing any non-trivial task");
    expect(prompt).not.toContain("At natural conversation breakpoints");
    expect(prompt).not.toContain("## Memory Write Rules");
  });
});
