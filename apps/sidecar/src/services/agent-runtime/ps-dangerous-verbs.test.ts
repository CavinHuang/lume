import { describe, expect, test } from "bun:test";
import { isNativeAvailable } from "@lume/natives";
import { isReadOnlyPowerShell, isReadOnlyShellInput, resetWindowsBashDiscoveryForTests } from "@lume/agent-sdk";
import { evaluateRuntimeToolSafety, type RuntimeToolSafetyContext } from "./guardrails/runtime-tool-safety";
import { classifyHeuristic } from "./permissions/permission-classifier";
import {
  CMD_WRAP_ANCHOR,
  PS_ANCHOR,
  PS_CLEAR_CONTENT_VERBS,
  PS_CONFIRM_COMMAND,
  PS_DELETE_COMMAND,
  PS_DANGEROUS_DELETE_FLAGS,
  PS_DANGEROUS_PROBES,
  PS_DYNAMIC_EXEC_VERBS,
  PS_FORMAT_VERBS,
  PS_STOP_VERBS,
  hasPowerShellContentSignal
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

  test("every shared probe stays outside the SDK read-only proof (#684 三层互锁)", () => {
    // 第三个消费方（SDK 只读证明 → 免审通道）接入防漂移体系：危险动词探针
    // 必须同时被 isReadOnlyPowerShell / isReadOnlyShellInput 拒绝。两判定均走
    // 纯正则/词表路径（探针不含显式前缀时 isReadOnlyShellInput 经语法树或
    // fail-closed 回退，两态结果一致为 false），无 natives 双态确定。
    for (const command of PS_DANGEROUS_PROBES) {
      expect(isReadOnlyPowerShell(command)).toBeFalse();
      expect(isReadOnlyShellInput({ command })).toBeFalse();
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
      // env 缺省走真实 process.env，才能命中「真实环境 + 未决」分支；platform 显式钉死，
      // 方言解析不随宿主平台漂移（Ubuntu CI 上分类器无参缺省曾读作 linux→bash 使词表关闭）
      const coldStart: RuntimeToolSafetyContext = { platform: "win32" };
      const firstCommand = { toolName: "Bash" as const, command: "Remove-Item -Recurse ~" };
      // 分类器与 guardrail 同口径注入 win32（分类器内部转小写，大小写无关）
      const classifyColdStart = { ...firstCommand, toolName: "bash", platform: "win32" as const };

      expect(evaluateRuntimeToolSafety(firstCommand.toolName, { command: firstCommand.command }, coldStart)).toEqual({
        behavior: "deny",
        reason: "禁止删除根目录或用户主目录"
      });
      const classification = classifyHeuristic(classifyColdStart);
      expect(classification.riskLevel).not.toBe("low");
      expect(classification.shouldAsk).toBe(true);

      // 显式配置 bash 后即使仍未决也回到精确读法：不再硬拒。Remove-Item 属无歧义
      // PS 危险动词，win32 上经内容信号保持确认档（#707 修复本体）；撞名命令
      // （iex/Elixir）不构成信号，维持 POSIX 口径判 low
      process.env.LUME_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";
      expect(
        evaluateRuntimeToolSafety(firstCommand.toolName, { command: firstCommand.command }, coldStart).behavior
      ).not.toBe("deny");
      const classificationExplicitBash = classifyHeuristic(classifyColdStart);
      expect(classificationExplicitBash.riskLevel).toBe("medium");
      expect(classificationExplicitBash.shouldAsk).toBe(true);
      expect(classifyHeuristic({ ...classifyColdStart, command: "iex -S mix phx.server" }).riskLevel).toBe("low");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetWindowsBashDiscoveryForTests();
    }
  });

  test("probes carrying the content signal escalate on bash-configured Windows (#707)", () => {
    // 信号通道接入既有探针防漂移体系：凡构成信号的探针在 win32+bash（方言读 bash、
    // 词表曾整层休眠）上下文两层都必须升级；无信号探针把「短别名无标志不构成信号」
    // 的刻意让步钉成被测试记录的决策（含 cmd 包裹内裸单文件删除等形态）
    const bashWin: RuntimeToolSafetyContext = {
      platform: "win32",
      env: { LUME_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe" }
    };
    // combo 形态判定与 guardrail FORCE_CONFIRM 第一条规则同源：无 natives 环境
    // parse-unavailable 兜底也会返回 confirm，必须断言 reason 区分升级来源
    const comboRule = new RegExp(
      String.raw`${PS_DELETE_COMMAND}[^\r\n;&|]*[^\S\r\n]${PS_DANGEROUS_DELETE_FLAGS}`,
      "i"
    );
    for (const command of PS_DANGEROUS_PROBES) {
      if (!hasPowerShellContentSignal(command)) {
        expect(hasPowerShellContentSignal(command)).toBe(false);
        continue;
      }
      const decision = evaluateRuntimeToolSafety("Bash", { command }, bashWin);
      if (comboRule.test(command)) {
        // combo 形态：词表规则在语法解析前命中，confirm 与 reason 双态确定
        // （无 natives 环境不得落 parse-unavailable 兜底，须证明升级来自词表）
        expect(decision.behavior).toBe("confirm");
        expect(decision.behavior === "confirm" && decision.reason).toBe("递归强制删除文件需要用户确认");
      } else {
        /*
         * 非 combo 信号探针（如 Get-Date␊Remove-Item ~）：删除族无标志形态在 bash 读法机
         * 上无确认规则（hard-deny 由真实方言独占），natives 解析成功时守卫层可 allow——
         * 只钉不 deny；防「判 low 静默放行」由下方分类器 medium 断言兜底（#707 修复本体）。
         * 无 natives 环境此分支落 parse-unavailable confirm，两态均通过。
         */
        expect(decision.behavior).not.toBe("deny");
      }
      const classification = classifyHeuristic({ toolName: "bash", command, shellKind: "bash", platform: "win32" });
      expect(classification.riskLevel).not.toBe("low");
      expect(classification.shouldAsk).toBe(true);
    }
  });

  test("content signal reactivates the vocabulary on bash-configured Windows hosts (#707)", () => {
    // win32 + 显式配置 bash：方言读作 bash、词表曾整层休眠，Remove-Item -Recurse -Force
    // 在 dontAsk 判 low 静默放行（guardrail 侧同样漏拦）。文本呈强 PS 形态时按 PS 规则评估。
    const bashWin: RuntimeToolSafetyContext = {
      platform: "win32",
      env: { LUME_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe" }
    };
    expect(
      evaluateRuntimeToolSafety("Bash", { command: "Remove-Item -Recurse -Force build" }, bashWin).behavior
    ).toBe("confirm");
    expect(evaluateRuntimeToolSafety("Bash", { command: "rd /s /q build" }, bashWin).behavior).toBe("confirm");

    // 短别名单独出现不构成信号：iex 不进 PS 词表。confirm 来源区分（防 iex 未来被误加进
    // 信号词表后「动态执行」确认规则命中仍绿）：只允许 parse-unavailable 兜底 confirm
    const iexDecision = evaluateRuntimeToolSafety("Bash", { command: "iex -S mix phx.server" }, bashWin);
    expect(iexDecision.behavior).not.toBe("deny");
    expect(
      iexDecision.behavior === "confirm" &&
        iexDecision.reason === "修改脚本执行策略或动态执行代码需要用户确认"
    ).toBe(false);

    // 非 win32 宿主不消费信号（与下方既定语义测试同口径）
    expect(evaluateRuntimeToolSafety("Bash", { command: "Remove-Item -Recurse -Force build" }, { platform: "linux" }).behavior).not.toBe("deny");

    // 参数/字符串位置的全名动词不构成信号（#717 follow-up）：第一支经命令位锚定，
    // echo 回显文本不再触发 UX 摩擦弹卡；命令位形态（分号/管道/换行后）仍命中
    expect(hasPowerShellContentSignal("echo remove-item deletes stuff")).toBe(false);
    expect(hasPowerShellContentSignal("echo 'stop-process' >> log")).toBe(false);
    expect(hasPowerShellContentSignal("grep -rn restart-computer src/")).toBe(false);
    expect(hasPowerShellContentSignal("Get-Date; Remove-Item x")).toBe(true);
  });

  test("non-win32 hosts keep the exact bash reading while Windows discovery is unsettled", () => {
    // 钉住非 win32 未决态既定语义：保守翻转只服务 win32 无 bash 机器的冷启动窗口。
    // 非 win32 宿主上 resolveShellInvocation 恒以 bash -c 执行，where.exe 发现也只在
    // win32 运行，「未决」并非真实状态；词表跨平台套用会把 POSIX 撞名命令（iex/ri）
    // 翻成弹审。Linux 装 pwsh 的场景外层解释器仍是 bash，显式 pwsh 前缀由
    // parse-unavailable 短路兜底（见 runtime-tool-safety POSIX 用例），不依赖本门控；
    // 若未来产品化「非 Windows 配置 pwsh 为执行 shell」，应走显式配置输入而非平台推断。
    // guardrail 断言只钉词表门控本身：无 natives 环境（Ubuntu CI 同款）会落到
    // parse-unavailable 通用确认，与方言无关，故不硬编码 allow。
    resetWindowsBashDiscoveryForTests();
    try {
      const command = "Remove-Item -Recurse ~";
      const decision = evaluateRuntimeToolSafety("Bash", { command }, { platform: "linux" });
      expect(decision.behavior).not.toBe("deny");
      expect(
        decision.behavior === "confirm" &&
          decision.reason !== "命令包含无法安全解析的 Shell 或 PowerShell 语法，需要一次性确认"
      ).toBe(false);
      const classification = classifyHeuristic({ toolName: "bash", command, platform: "linux" });
      expect(classification.riskLevel).toBe("low");
      expect(classification.shouldAsk).toBe(false);
    } finally {
      resetWindowsBashDiscoveryForTests();
    }
  });
});
