import { describe, expect, test } from "bun:test";
import { isNativeAvailable } from "@lume/natives";
import { resetWindowsBashDiscoveryForTests } from "@lume/agent-sdk";
import { evaluateRuntimeToolSafety, type RuntimeToolSafetyContext } from "./guardrails/runtime-tool-safety";
import { classifyHeuristic } from "./permissions/permission-classifier";
import {
  CMD_WRAP_ANCHOR,
  PS_ANCHOR,
  PS_CLEAR_CONTENT_VERBS,
  PS_CONFIRM_COMMAND,
  PS_DELETE_COMMAND,
  PS_DANGEROUS_PROBES,
  PS_DYNAMIC_EXEC_VERBS,
  PS_FORMAT_VERBS,
  PS_STOP_VERBS
} from "./ps-dangerous-verbs";

// 与 runtime-tool-safety.test 同款确定性方言上下文（win32 + 显式空 env → powershell）
const POWERSHELL_SHELL = { platform: "win32" as const, env: {} };

// 仅用于探针覆盖断言的包裹形态判定（与生产锚点同源，避免测试内联正则漂移）
const CMD_WRAP_ANCHOR_TEST = new RegExp(CMD_WRAP_ANCHOR, "i");

describe("PowerShell dangerous verb vocabulary cross-layer consistency", () => {
  test("probe list covers every vocabulary group", () => {
    // 新增动词必须带探针：这里钉住探针对每个词表组的覆盖（含 cmd 包裹形态，
    // 防止包裹识别只并入单侧规则组的组合缺口复发）
    for (const group of [PS_STOP_VERBS, PS_DYNAMIC_EXEC_VERBS, PS_FORMAT_VERBS, PS_CLEAR_CONTENT_VERBS]) {
      const anchored = new RegExp(`${PS_ANCHOR}${group}\\b`, "i");
      expect(PS_DANGEROUS_PROBES.some((probe) => anchored.test(probe))).toBe(true);
      const wrapped = new RegExp(`${PS_CONFIRM_COMMAND}${group}\\b`, "i");
      expect(PS_DANGEROUS_PROBES.some((probe) => CMD_WRAP_ANCHOR_TEST.test(probe) && wrapped.test(probe))).toBe(true);
    }
    expect(PS_DANGEROUS_PROBES.some((probe) => new RegExp(PS_DELETE_COMMAND, "i").test(probe))).toBe(true);
    expect(PS_DANGEROUS_PROBES.some((probe) => new RegExp(CMD_WRAP_ANCHOR, "i").test(probe))).toBe(true);
  });

  test("every shared probe triggers both guardrails and heuristic classifier", () => {
    // 防漂移：format-* 曾只进 guardrail 一层；两层各自消费同一词表后，探针必须双双命中
    for (const command of PS_DANGEROUS_PROBES) {
      const decision = evaluateRuntimeToolSafety("Bash", { command }, POWERSHELL_SHELL);
      expect(["deny", "confirm"]).toContain(decision.behavior);

      const classification = classifyHeuristic({ toolName: "bash", command, shellKind: "powershell" });
      expect(classification.riskLevel).not.toBe("low");
      expect(classification.shouldAsk).toBe(true);
    }
  });

  test.skipIf(!isNativeAvailable())("benign lookalikes stay untouched in both layers", () => {
    for (const command of ["cmd /c dir build", "cmd /c cmd /c dir build", "Get-ChildItem | Format-Table"]) {
      expect(evaluateRuntimeToolSafety("Bash", { command }, POWERSHELL_SHELL).behavior).toBe("allow");
      expect(classifyHeuristic({ toolName: "bash", command, shellKind: "powershell" }).riskLevel).toBe("low");
    }
  });

  test("fails closed on the first command while Windows bash discovery is unsettled", () => {
    // 复核实证：win32 无 bash 机器生命周期首条命令评估时 discovery 必然未决，
    // 词表曾整层不激活（fail-open）。未决窗口按保守侧读作 powershell；
    // 显式配置 bash 的机器不受翻转影响（iex/ri 撞名防误拦口径保持）。
    const configKeys = ["LUME_BASH_PATH", "CLAUDE_CODE_SHELL", "SHELL"] as const;
    const saved = configKeys.map((key) => [key, process.env[key]] as const);
    for (const [key] of saved) delete process.env[key];
    try {
      resetWindowsBashDiscoveryForTests();
      // env 缺省走真实 process.env，才能命中「真实环境 + 未决」分支
      const coldStart: RuntimeToolSafetyContext = { platform: "win32" };
      const firstCommand = { toolName: "Bash" as const, command: "Remove-Item -Recurse ~" };

      expect(evaluateRuntimeToolSafety(firstCommand.toolName, { command: firstCommand.command }, coldStart)).toEqual({
        behavior: "deny",
        reason: "禁止删除根目录或用户主目录"
      });
      const classification = classifyHeuristic(firstCommand);
      expect(classification.riskLevel).not.toBe("low");
      expect(classification.shouldAsk).toBe(true);

      // 显式配置 bash 后即使仍未决也回到精确读法：不再硬拒，分类器回落 POSIX 口径
      process.env.LUME_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";
      expect(
        evaluateRuntimeToolSafety(firstCommand.toolName, { command: firstCommand.command }, coldStart).behavior
      ).not.toBe("deny");
      expect(classifyHeuristic(firstCommand).riskLevel).toBe("low");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetWindowsBashDiscoveryForTests();
    }
  });
});
