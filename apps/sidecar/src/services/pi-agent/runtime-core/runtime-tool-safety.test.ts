import { describe, expect, test } from "bun:test";
import { evaluateRuntimeToolSafety } from "./runtime-tool-safety";

describe("runtime-tool-safety", () => {
  test("hard denies catastrophic bash commands", () => {
    expect(evaluateRuntimeToolSafety("Bash", { command: "rm -rf /" })).toEqual({
      behavior: "deny",
      reason: "禁止删除根目录"
    });
    expect(evaluateRuntimeToolSafety("bash", { command: ":(){ :|:& };:" }).behavior).toBe("deny");
  });

  test("requires confirmation for git history and external publishing commands", () => {
    expect(evaluateRuntimeToolSafety("Bash", { command: "git commit -m test" })).toEqual({
      behavior: "confirm",
      reason: "git commit 会写入仓库历史，需要用户确认"
    });
    expect(evaluateRuntimeToolSafety("Bash", { command: "git push origin main" })).toEqual({
      behavior: "confirm",
      reason: "git push 会向外部远端发布内容，需要用户确认"
    });
  });

  test("allows ordinary read-only shell commands", () => {
    expect(evaluateRuntimeToolSafety("Bash", { command: "rg prompt apps/sidecar/src" })).toEqual({
      behavior: "allow"
    });
  });

  test("does not apply bash rules to non-bash tools", () => {
    expect(evaluateRuntimeToolSafety("Write", { command: "git push" })).toEqual({
      behavior: "allow"
    });
  });

  test("requires confirmation for global memory and automation mutations even outside bash", () => {
    expect(evaluateRuntimeToolSafety("memory.promoteGlobal", { candidateId: "c1", approve: true })).toEqual({
      behavior: "confirm",
      reason: "提升到全局记忆会影响跨工作区记忆，需要用户确认"
    });
    expect(evaluateRuntimeToolSafety("automation_set", { action: "delete", id: "job-1" })).toEqual({
      behavior: "confirm",
      reason: "修改自动化任务会影响未来定时执行，需要用户确认"
    });
  });
});
