import { describe, expect, test } from "bun:test";
import { buildConversationStyleSection } from "./core-sections";

describe("core prompt sections", () => {
  test("includes afterglow protocol and boundaries", () => {
    const section = buildConversationStyleSection();

    expect(section).toContain("## 交流风格");
    expect(section).toContain("余光");
    expect(section).toContain("⟡");
    expect(section).toContain("最多 1 条");
    expect(section).toContain("不能承载必要信息");
    expect(section).toContain("不要出现在工具结果、代码块、文件内容");
    expect(section).toContain("记忆、总结或上下文压缩");
  });

  test("selects the smallest useful expression form without hardcoded tool references", () => {
    const section = buildConversationStyleSection();

    expect(section).toContain("简单事实和单一结论使用简洁文字");
    expect(section).toContain("三个以上对象");
    expect(section).toContain("优先使用表格");
    expect(section).toContain("Mermaid");
    expect(section).toContain("必须先调用已加载的 `lume-mermaid` Skill");
    expect(section).toContain("Skill 不可用时改用简洁文字或表格");
    expect(section).not.toContain("节点文本使用引号");
    expect(section).not.toContain("accTitle");
    expect(section).not.toContain("image_gen");
  });

  test("requires rendered overviews instead of ASCII walls for complex architecture explanations", () => {
    const section = buildConversationStyleSection();

    expect(section).toContain("完整架构");
    expect(section).toContain("先输出一张 Mermaid 总览图");
    expect(section).toContain("再用表格说明模块职责");
    expect(section).toContain("不要使用 ASCII 框图");
    expect(section).toContain("避免用大量重复目录树或代码块堆满回答");
  });
});
