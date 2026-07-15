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

  test("selects the smallest useful expression form and gates proactive image generation", () => {
    const section = buildConversationStyleSection();

    expect(section).toContain("简单事实和单一结论使用简洁文字");
    expect(section).toContain("三个以上对象");
    expect(section).toContain("优先使用表格");
    expect(section).toContain("Mermaid");
    expect(section).toContain("不超过 12 个节点");
    expect(section).toContain("accTitle");
    expect(section).toContain("明确要求生成图片");
    expect(section).toContain("先说明用途并请求确认");
    expect(section).toContain("用户明确指定的表达形式始终优先");
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
