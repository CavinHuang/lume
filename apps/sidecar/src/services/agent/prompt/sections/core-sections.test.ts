import { describe, expect, test } from "bun:test";
import { buildConversationStyleSection } from "./core-sections";

describe("core prompt sections", () => {
  test("includes afterglow protocol and boundaries", () => {
    const section = buildConversationStyleSection();

    expect(section).toContain("## Conversation Style");
    expect(section).toContain("余光");
    expect(section).toContain("⟡");
    expect(section).toContain("最多 1 条");
    expect(section).toContain("不能承载必要信息");
    expect(section).toContain("不要出现在工具结果、代码块、文件内容");
    expect(section).toContain("记忆、总结或上下文压缩");
  });
});
