import { describe, expect, test } from "bun:test";
import { CLAUDE_PLAN_MODE_SECTION } from "./static-policy-sections";

describe("static policy sections", () => {
  test("agent role handoff instructions mention explicit subagent_type routing", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("subagent_type");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("developer");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("designer");
  });

  test("long-form prose is delegated to the writing agent", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("先移交给 writer 角色再动笔");
  });

  test("main agent should directly create subagents for complex specialized work", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("主动使用子代理");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("重上下文或跨领域");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("explorer -> planner -> specialist -> code-reviewer");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("仅在目标含糊");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("内置角色包括 explorer、planner、code-reviewer、researcher");
  });

  test("capability ladder keeps memory and web lookups conditional", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("仅在需要且尚未加载先前上下文时才用记忆工具");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("需要最新公开信息时使用 WebSearch/WebFetch");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("可并行或需要评审的任务");
  });

  test("coding loop keeps verification hard rules", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("绝不接 grep、findstr、Select-String、head 或 tail 管道");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("不要轮询其输出");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("绝不作为编码收尾自动 commit、push、reset、clean 或删除分支");
  });

  // #574：PR#276 删掉的四条语义回迁——完工查 diff / 不发明验证命令 /
  // 失败同 Run 内修复。与 coding-verification 的选令逻辑口径一致。
  test("coding loop restores the deleted teaching semantics (#574)", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("宣布完成前先查看最终 Diff");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("没有可靠脚本时不要发明验证命令，如实说明未验证即可");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("验证失败就在同一 Run 内修复后重验");
  });
});
