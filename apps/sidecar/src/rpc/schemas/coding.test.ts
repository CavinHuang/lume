import { describe, expect, test } from "bun:test";
import { codingRepositoryPublishActionInputSchema } from "./coding";

const COMMIT_INPUT_BASE = {
  action: "commit",
  threadId: "t1",
  expectedBranch: "main",
  expectedHead: "a".repeat(40),
  expectedIndexHash: "b".repeat(64),
  message: "test: publish",
};

describe("coding repository publish action schema", () => {
  test("包含未暂存变更且缺工作区指纹时提示超限根因", () => {
    const result = codingRepositoryPublishActionInputSchema.safeParse({
      ...COMMIT_INPUT_BASE,
      includeUnstagedChanges: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join("\n");
      expect(messages).toContain("16MB");
    }
  });

  test("带合法工作区指纹的完整输入通过校验", () => {
    const result = codingRepositoryPublishActionInputSchema.safeParse({
      ...COMMIT_INPUT_BASE,
      includeUnstagedChanges: true,
      expectedWorktreeHash: "c".repeat(64),
    });
    expect(result.success).toBe(true);
  });

  test("仅提交已暂存内容无需工作区指纹", () => {
    const result = codingRepositoryPublishActionInputSchema.safeParse({ ...COMMIT_INPUT_BASE });
    expect(result.success).toBe(true);
  });
});
