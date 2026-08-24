import { describe, expect, test } from "bun:test";
import { isNativeAvailable } from "@lume/natives";
import { evaluateRuntimeToolSafety } from "./guardrails/runtime-tool-safety";
import { classifyHeuristic } from "./permissions/permission-classifier";
import {
  CMD_WRAP_ANCHOR,
  PS_ANCHOR,
  PS_CLEAR_CONTENT_VERBS,
  PS_DELETE_COMMAND,
  PS_DANGEROUS_PROBES,
  PS_DYNAMIC_EXEC_VERBS,
  PS_FORMAT_VERBS,
  PS_STOP_VERBS
} from "./ps-dangerous-verbs";

// 与 runtime-tool-safety.test 同款确定性方言上下文（win32 + 显式空 env → powershell）
const POWERSHELL_SHELL = { platform: "win32" as const, env: {} };

describe("PowerShell dangerous verb vocabulary cross-layer consistency", () => {
  test("probe list covers every vocabulary group", () => {
    // 新增动词必须带探针：这里钉住探针对每个词表组的覆盖
    for (const group of [PS_STOP_VERBS, PS_DYNAMIC_EXEC_VERBS, PS_FORMAT_VERBS, PS_CLEAR_CONTENT_VERBS]) {
      const anchored = new RegExp(`${PS_ANCHOR}${group}\\b`, "i");
      expect(PS_DANGEROUS_PROBES.some((probe) => anchored.test(probe))).toBe(true);
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
    for (const command of ["cmd /c dir build", "Get-ChildItem | Format-Table"]) {
      expect(evaluateRuntimeToolSafety("Bash", { command }, POWERSHELL_SHELL).behavior).toBe("allow");
      expect(classifyHeuristic({ toolName: "bash", command, shellKind: "powershell" }).riskLevel).toBe("low");
    }
  });
});
